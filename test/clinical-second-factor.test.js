"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { signPayload } = require("../services/auth");
const { createSecondFactorCheck } = require("../services/clinical-second-factor");
const createMiddleware = require("../middleware/therapySecondFactor");

const secret = "synthetic-session-signing-secret";
function recorder() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function session(changes = {}) {
  return signPayload({ uid: "owner", token_type: "twofa_session", version: "v2", exp: Date.now() + 60_000, ...changes }, secret);
}

test("enrolled accounts require a valid signed second factor bound to identity and current enrollment", async () => {
  const check = createSecondFactorCheck({ secret, loadProfile: async () => ({ twoFactorEnabled: true, twoFactorVersion: "v2" }) });
  for (const token of ["", "invalid", session({ uid: "foreign" }), session({ version: "v1" }), session({ token_type: "game_access" }), session({ exp: Date.now() - 1 })]) {
    const req = { headers: { "x-therapy-2fa": token } }, res = recorder();
    assert.equal(await check(req, res, "owner"), false);
    assert.equal(res.statusCode, 401);
    assert.equal(req.therapyTwoFactor, undefined);
  }
  const req = { headers: { "x-therapy-2fa": session() } };
  assert.equal(await check(req, recorder(), "owner"), true);
  assert.deepEqual(req.therapyTwoFactor, { uid: "owner", verified: true });
});

test("unregistered callers remain subject to route authorization; registered professionals must enroll", async () => {
  for (const profile of [{}, { twoFactorEnabled: false }]) {
    const check = createSecondFactorCheck({ secret, loadProfile: async () => profile });
    const res = recorder();
    assert.equal(await check({ headers: {} }, res, "owner"), false);
    assert.equal(res.body.error, "TWOFA_ENROLLMENT_REQUIRED");
  }
  const absent = createSecondFactorCheck({ secret, loadProfile: async () => null });
  assert.equal(await absent({ headers: {} }, recorder(), "unknown"), true);
  const privileged = recorder();
  assert.equal(await absent({ headers: {} }, privileged, "rt-without-professional-profile", { required: true }), false);
  assert.equal(privileged.body.error, "TWOFA_ENROLLMENT_REQUIRED");
  const check = createSecondFactorCheck({ secret, loadProfile: async () => { throw new Error("DATABASE_OFFLINE"); } });
  await assert.rejects(check({ headers: {} }, recorder(), "owner"), /DATABASE_OFFLINE/);
});

test("real Express case and trailing-slash routing cannot bypass the server second factor", async t => {
  const app = express();
  const enforce = createSecondFactorCheck({ secret, loadProfile: async () => ({ twoFactorEnabled: true, twoFactorVersion: "v2" }) });
  app.use(createMiddleware({ authenticate: async () => ({ uid: "owner" }), enforce }));
  app.get("/therapy/profissional/me", (req, res) => res.json({ marker: "synthetic-private", verified: req.firebaseRevocationChecked }));
  app.post("/therapy/2fa/verify", (_req, res) => res.json({ challenge: true }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.once("listening", resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/therapy/profissional/me", "/THERAPY/profissional/me", "/Therapy/Profissional/Me/"]) {
    const denied = await fetch(root + path, { headers: { Authorization: "Bearer synthetic" } });
    assert.equal(denied.status, 401, path);
    assert.equal((await denied.json()).error, "TWOFA_REQUIRED");
    const allowed = await fetch(root + path, { headers: { Authorization: "Bearer synthetic", "X-Therapy-2FA": session() } });
    assert.equal(allowed.status, 200, path);
    assert.equal((await allowed.json()).verified, true);
  }
  for (const path of ["/therapy/2fa/verify", "/THERAPY/2FA/VERIFY/"]) {
    assert.equal((await fetch(root + path, { method: "POST", headers: { Authorization: "Bearer synthetic" } })).status, 200);
  }
});

test("RT authorization checks the enrolled second factor after role validation", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), acorn = require("acorn");
  const source = fs.readFileSync(require("node:path").join(__dirname, "../routes/rt.js"), "utf8");
  const node = acorn.parse(source, { ecmaVersion: "latest" }).body.find(n => n.type === "FunctionDeclaration" && n.id.name === "authenticateRt");
  let enrolledChecks = 0;
  const authenticateRt = vm.runInNewContext("(" + source.slice(node.start, node.end) + ")", {
    ensureDb: () => true, getBearerToken: () => "synthetic",
    admin: { auth: () => ({ verifyIdToken: async (_token, revoked) => { assert.equal(revoked, true); return { uid: "owner", email: "rt@example.invalid", email_verified: true }; } }) },
    normalizeEmail: email => email, THERAPY_ADMIN_EMAILS: [], THERAPY_RT_EMAILS: ["rt@example.invalid"],
    cleanText: value => value,
    sendError: (res, status, error) => res.status(status).json({ error }),
    requireSecondFactor: async (req, res, uid) => {
      enrolledChecks++;
      return createSecondFactorCheck({ secret, loadProfile: async () => ({ twoFactorEnabled: true, twoFactorVersion: "v2" }) })(req, res, uid);
    }
  });
  const denied = recorder();
  assert.equal(await authenticateRt({ headers: {} }, denied), null);
  assert.equal(denied.statusCode, 401);
  const actor = await authenticateRt({ headers: { "x-therapy-2fa": session() } }, recorder());
  assert.equal(actor.uid, "owner");
  assert.equal(enrolledChecks, 2);
});
