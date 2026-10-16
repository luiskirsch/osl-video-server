"use strict";
// Input is a JSON object on stdin. Never pass service-account credentials as
// command-line arguments. This tool refuses production and removes its fixtures.
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const credential = typeof config.serviceAccount === "string" ? JSON.parse(config.serviceAccount) : config.serviceAccount;
  const base = "https://osl-video-server-staging.up.railway.app";
  assert.equal(credential.project_id, "sextolugar-staging", "PRODUCTION_REFUSED");
  assert.equal(config.backend, base, "UNEXPECTED_BACKEND_REFUSED");
  assert.ok(config.apiKey, "STAGING_PUBLIC_API_KEY_REQUIRED");
  if (credential.private_key) credential.private_key = credential.private_key.replace(/\\n/g, "\n");
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id });
  const auth = getAuth(app), db = getFirestore(app);
  const privateFiles = require("../../services/private-files");
  const { totp } = require("../../services/twofa");
  const prefix = "preludio-security-" + crypto.randomBytes(8).toString("hex");
  const createdUsers = [], createdDocs = [], createdFiles = [];
  const report = { environment: "staging", syntheticOnly: true, startedAt: new Date().toISOString(), checks: [], cleanupComplete: false };
  let failed;
  async function create(collection, id, data) {
    assert.ok(id.startsWith(prefix), "UNSAFE_FIXTURE_ID");
    const ref = db.collection(collection).doc(id);
    await ref.create(data); createdDocs.push(ref);
  }
  async function token(uid) {
    const custom = await auth.createCustomToken(uid);
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + encodeURIComponent(config.apiKey), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }), signal: AbortSignal.timeout(20000)
    });
    assert.equal(r.status, 200, "CUSTOM_SIGNIN_FAILED");
    const result = await r.json(); assert.ok(result.idToken);
    return result.idToken;
  }
  async function request(name, path, bearer, expected, validate, extraHeaders = {}) {
    const headers = { Accept: "application/json", ...extraHeaders };
    if (bearer) headers.Authorization = "Bearer " + bearer;
    const r = await fetch(base + path, { headers, cache: "no-store", signal: AbortSignal.timeout(20000) });
    report.checks.push({ name, status: r.status, expected, noStore: /no-store/.test(r.headers.get("Cache-Control") || "") });
    assert.equal(r.status, expected, name);
    assert.match(r.headers.get("Cache-Control") || "", /no-store/, name);
    if (validate) validate(await r.json()); else if (r.body) await r.body.cancel();
  }
  async function twofa(action, bearer, body = {}) {
    const r = await fetch(base + "/therapy/2fa/" + action, { method: "POST", headers: {
      Authorization: "Bearer " + bearer, "Content-Type": "application/json"
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    report.checks.push({ name: "synthetic second-factor " + action, status: r.status, expected: 200 });
    assert.equal(r.status, 200, "SYNTHETIC_TWOFA_" + action);
    return r.json();
  }
  try {
    const uids = [prefix + "-a", prefix + "-b", prefix + "-game"];
    for (const uid of uids) {
      await auth.createUser({ uid, email: uid + "@example.invalid", emailVerified: true }); createdUsers.push(uid);
    }
    const [a, b, game] = uids;
    for (const uid of [a, b]) await create("therapists", uid, { uid, displayName: "SYNTHETIC SECURITY TEST" });
    const patientId = prefix + "-patient", sessionId = prefix + "-session";
    await create("therapy_patients", patientId, { therapistUid: a, displayName: "SYNTHETIC SECURITY TEST", marker: prefix });
    for (const [suffix, uid] of [["a", a], ["b", b]]) await create("therapy_patient_notes", prefix + "-note-" + suffix, {
      noteId: prefix + "-note-" + suffix, patientAccountUid: uid,
      sessionId: suffix === "a" ? sessionId : prefix + "-other-session",
      ciphertext: crypto.randomBytes(32).toString("base64"), iv: crypto.randomBytes(12).toString("base64")
    });
    const [tokenA, tokenB, gameToken] = await Promise.all(uids.map(token));
    const target = "/therapy/pacientes/" + patientId;
    await request("owner reads own synthetic patient", target, tokenA, 200, body => assert.equal(body.patient?.marker, prefix));
    await request("other therapist denied", target, tokenB, 403);
    await request("game-only account denied", target, gameToken, 403);
    await request("anonymous caller denied", target, null, 401);
    await request("invalid token denied", target, "invalid-security-fixture", 401);
    const notes = "/therapy/paciente/notas?sessionId=" + sessionId;
    await request("own patient notes are scoped", notes, tokenA, 200, body => {
      assert.equal(body.notes?.length, 1); assert.equal(body.notes[0].noteId, prefix + "-note-a");
    });
    await request("foreign session selector cannot override patient ownership", notes + "&uid=" + a, tokenB, 200, body => assert.equal(body.notes?.length, 0));
    await request("game account cannot query another patient's notes", notes, gameToken, 200, body => assert.equal(body.notes?.length, 0));
    for (const [name, bearer] of [["anonymous", null], ["authenticated fixture", tokenA]]) {
      const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
      const r = await fetch("https://firestore.googleapis.com/v1/projects/sextolugar-staging/databases/(default)/documents/therapy_patients/" + patientId + "?key=" + encodeURIComponent(config.apiKey), { headers, signal: AbortSignal.timeout(20000) });
      report.checks.push({ name: "direct Firestore read denied: " + name, status: r.status, expected: 403 });
      assert.equal(r.status, 403, "DIRECT_FIRESTORE_ACCESS"); if (r.body) await r.body.cancel();
    }
    const bytes = crypto.randomBytes(700_021);
    const file = await privateFiles.savePrivateFile(prefix + "-private-document", bytes, { contentType: "application/pdf" });
    createdFiles.push(file);
    assert.deepEqual(await privateFiles.readPrivateFile(file), bytes);
    report.checks.push({ name: "server private-document atomic round-trip", passed: true });
    for (const [name, bearer] of [["anonymous", null], ["authenticated fixture", tokenA]]) {
      const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
      const r = await fetch("https://firestore.googleapis.com/v1/projects/sextolugar-staging/databases/(default)/documents/private_files/" + file.slice(3) + "/chunks/000?key=" + encodeURIComponent(config.apiKey), { headers, signal: AbortSignal.timeout(20000) });
      report.checks.push({ name: "direct private chunk read denied: " + name, status: r.status, expected: 403 });
      assert.equal(r.status, 403, "DIRECT_PRIVATE_FILE_ACCESS"); if (r.body) await r.body.cancel();
    }
    await create("therapy_rt_assignments", prefix + "-rt", { email: a + "@example.invalid", active: true, name: "SYNTHETIC SECURITY TEST" });
    await request("authorized RT before enrollment", "/rt/me", tokenA, 200);
    const setup = await twofa("setup", tokenA);
    assert.ok(setup.secret);
    const enabled = await twofa("enable", tokenA, { code: totp(setup.secret) });
    assert.ok(enabled.sessionToken);
    await request("enrolled therapist without proof denied", target, tokenA, 401);
    await request("case variant cannot bypass second factor", target.replace("/therapy/", "/THERAPY/"), tokenA, 401);
    await request("enrolled RT without proof denied", "/rt/me", tokenA, 401);
    await request("enrolled RT with invalid proof denied", "/RT/me/", tokenA, 401, null, { "X-Therapy-2FA": "invalid-fixture" });
    const proof = { "X-Therapy-2FA": enabled.sessionToken };
    await request("enrolled therapist with proof allowed", target, tokenA, 200, null, proof);
    await request("enrolled RT with proof allowed", "/rt/me", tokenA, 200, null, proof);
    await request("another account cannot borrow second-factor proof", target, tokenB, 403, null, proof);
    const verified = await twofa("verify", tokenA, { code: totp(setup.secret) });
    assert.ok(verified.sessionToken);
    await twofa("disable", tokenA, { code: totp(setup.secret) });
    await request("synthetic account recovers normal access after disabling", target, tokenA, 200);
    const authTime = JSON.parse(Buffer.from(tokenA.split(".")[1], "base64url").toString()).auth_time;
    let revoked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await auth.revokeRefreshTokens(a);
      const user = await auth.getUser(a);
      if (Date.parse(user.tokensValidAfterTime) / 1000 > authTime) { revoked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    assert.ok(revoked, "REVOCATION_CUTOFF_NOT_ADVANCED");
    await request("revoked real Firebase session denied", target, tokenA, 401);
  } catch (error) {
    failed = error;
    report.failure = { code: error.code || "CHECK_FAILED", message: error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Provider operation failed; sensitive details omitted" };
  } finally {
    const cleanup = await Promise.allSettled([
      ...createdDocs.map(ref => ref.delete()),
      ...createdFiles.map(path => privateFiles.deletePrivateFile(path)),
      ...createdUsers.map(uid => { assert.ok(uid.startsWith(prefix)); return auth.deleteUser(uid); })
    ]);
    report.cleanupComplete = cleanup.every(item => item.status === "fulfilled");
    report.fixtureDocuments = createdDocs.length; report.fixtureUsers = createdUsers.length;
    report.fixtureFiles = createdFiles.length;
    report.finishedAt = new Date().toISOString();
    await deleteApp(app);
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failed || !report.cleanupComplete) process.exitCode = 1;
}
main().catch(() => { console.error("Staging test setup failed; no credentials exported"); process.exitCode = 1; });
