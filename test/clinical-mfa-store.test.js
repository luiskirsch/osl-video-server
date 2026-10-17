"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMfaStore } = require("../services/clinical-mfa-store");
const { totp } = require("../services/twofa");
const { verifySignedToken } = require("../services/auth");
const { FieldValue } = require("firebase-admin/firestore");

const signingSecret = "synthetic-test-secret-for-mfa-at-rest-and-session-signatures";
function fixture() {
  const rows = new Map([["therapists/owner", { displayName: "SYNTHETIC" }]]);
  let clock = 1_800_000_000_000, serial = Promise.resolve(), id = 0;
  const stampDelete = FieldValue.delete();
  function ref(path) { return { path, get: async () => ({ exists: rows.has(path), data: () => rows.get(path) }) }; }
  const database = { collection: name => ({ doc: nameId => ref(name + "/" + (nameId || "audit-" + (++id))) }),
    runTransaction(operation) {
      const run = serial.then(async () => {
        const changes = [];
        const result = await operation({ get: ref => ref.get(), set: (ref, data) => changes.push({ ref, data }),
          create: (ref, data) => { if (rows.has(ref.path)) throw new Error("ALREADY_EXISTS"); changes.push({ ref, data }); } });
        for (const { ref, data } of changes) {
          const updated = { ...(rows.get(ref.path) || {}), ...data };
          for (const [key, value] of Object.entries(data)) if (value?.isEqual?.(stampDelete)) delete updated[key];
          rows.set(ref.path, updated);
        }
        return result;
      });
      serial = run.catch(() => {}); return run;
    }
  };
  return { rows, mfa: createMfaStore({ database: () => database, signingSecret, now: () => clock }),
    advance: ms => { clock += ms; }, code: secret => totp(secret, Math.floor(clock / 30_000)) };
}

test("enrollment stores only encrypted seeds and hashed recovery codes and binds sessions to login time", async () => {
  const f = fixture();
  const setup = await f.mfa.setup("owner", "SYNTHETIC");
  assert.match(setup.otpauthUrl, /^otpauth:/);
  assert.doesNotMatch(JSON.stringify([...f.rows.values()]), new RegExp(setup.secret));
  const result = await f.mfa.enable("owner", f.code(setup.secret), 1_800_000_000);
  assert.equal(result.recoveryCodes.length, 8);
  const record = f.rows.get("therapy_security_accounts/owner");
  assert.equal(record.twoFactorEnabled, true);
  assert.equal(record.twoFactorPendingSealed, undefined);
  assert.equal(record.twoFactorRecoveryHashes.length, 8);
  const serialized = JSON.stringify([...f.rows.values()]);
  assert.equal(serialized.includes(setup.secret), false);
  for (const code of result.recoveryCodes) assert.equal(serialized.includes(code), false);
  const proof = verifySignedToken(result.sessionToken, signingSecret);
  assert.equal(proof.valid, true); assert.equal(proof.payload.auth_time, 1_800_000_000);
  assert.equal(proof.payload.uid, "owner");
  assert.ok([...f.rows.keys()].some(path => path.startsWith("therapy_audit/")));
});

test("expired or incorrect enrollment cannot activate MFA", async () => {
  const f = fixture(); await f.mfa.setup("owner", "SYNTHETIC");
  await assert.rejects(f.mfa.enable("owner", "invalid", 1_800_000_000), { code: "CODIGO_INCORRETO" });
  f.advance(11 * 60_000);
  await assert.rejects(f.mfa.enable("owner", "123456", 1_800_000_000), { code: "SETUP_EXPIRADO" });
  assert.notEqual(f.rows.get("therapy_security_accounts/owner").twoFactorEnabled, true);
});

test("a TOTP can be consumed only once, including concurrent attempts", async () => {
  const f = fixture(), setup = await f.mfa.setup("owner", "SYNTHETIC");
  await f.mfa.enable("owner", f.code(setup.secret), 1_800_000_000);
  await assert.rejects(f.mfa.verify("owner", f.code(setup.secret), 1_800_000_000), { code: "CODIGO_REUTILIZADO" });
  f.advance(30_000);
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => f.mfa.verify("owner", f.code(setup.secret), 1_800_000_000)));
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(value => value.status === "rejected" && value.reason.code === "CODIGO_REUTILIZADO").length, 4);
});

test("recovery revokes the old session generation and requires a new authenticator; codes cannot be replayed", async () => {
  const f = fixture(), setup = await f.mfa.setup("owner", "SYNTHETIC");
  const enrolled = await f.mfa.enable("owner", f.code(setup.secret), 1_800_000_000);
  const version = f.rows.get("therapy_security_accounts/owner").twoFactorVersion;
  await assert.rejects(f.mfa.recover("owner", "invalid"), { code: "CODIGO_RECUPERACAO_INVALIDO" });
  const result = await f.mfa.recover("owner", enrolled.recoveryCodes[0]);
  assert.equal(result.status, "reenrollment_required");
  const state = await f.mfa.load("owner");
  assert.equal(state.twoFactorEnabled, false); assert.equal(state.twoFactorRequired, true);
  assert.notEqual(state.twoFactorVersion, version);
  assert.equal(state.twoFactorSecretSealed, undefined);
  await assert.rejects(f.mfa.recover("owner", enrolled.recoveryCodes[0]), { code: "CODIGO_RECUPERACAO_INVALIDO" });
  const next = await f.mfa.setup("owner", "SYNTHETIC");
  assert.notEqual(next.secret, setup.secret);
  await f.mfa.enable("owner", f.code(next.secret), 1_800_000_030);
  assert.equal((await f.mfa.load("owner")).twoFactorEnabled, true);
});

test("encrypted seeds cannot be transplanted to another account", async () => {
  const f = fixture(), setup = await f.mfa.setup("owner", "SYNTHETIC");
  const pending = f.rows.get("therapy_security_accounts/owner");
  f.rows.set("therapy_security_accounts/foreign", { ...pending });
  await assert.rejects(f.mfa.enable("foreign", f.code(setup.secret), 1_800_000_000));
  assert.notEqual((await f.mfa.load("foreign")).twoFactorEnabled, true);
});
