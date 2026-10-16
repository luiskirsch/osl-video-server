"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
require("../services/firestore");
const { verifyFirebaseToken, signPayload, verifySignedToken } = require("../services/auth");
const clinicalSecurity = require("../middleware/clinicalSecurity");

function recorder() {
  return { statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    vary(value) { this.headers.Vary = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}

test("clinical success and error responses prevent storage; game routing is unchanged", () => {
  for (const path of ["/therapy/paciente/me", "/THERAPY/notas", "/institution/overview", "/rt/me", "/empresa/dashboard", "/public/receita"]) {
    const req = { path }, res = recorder();
    let next = false;
    clinicalSecurity(req, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(req.requireFirebaseRevocationCheck, true);
    assert.match(res.headers["Cache-Control"], /no-store/);
    assert.equal(res.headers["Referrer-Policy"], "no-referrer");
    assert.equal(res.headers.Vary, "Authorization");
  }
  const req = { path: "/game/rooms" }, res = recorder();
  clinicalSecurity(req, res, () => {});
  assert.deepEqual(res.headers, {});
});

test("clinical authentication rejects revoked tokens and cannot reuse an unchecked identity", async t => {
  const calls = [];
  t.mock.method(admin, "auth", () => ({ verifyIdToken: async (token, checkRevoked) => {
    calls.push({ token, checkRevoked });
    throw Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" });
  } }));
  const req = { headers: { authorization: "Bearer revoked" }, requireFirebaseRevocationCheck: true,
    verifiedFirebaseToken: { uid: "cached-user" } };
  const res = recorder();
  assert.equal(await verifyFirebaseToken(req, res), null);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, [{ token: "revoked", checkRevoked: true }]);
});

test("revocation-checked identity is reused only within its request", async t => {
  let calls = 0;
  t.mock.method(admin, "auth", () => ({ verifyIdToken: async (_token, checkRevoked) => {
    assert.equal(checkRevoked, true); calls++; return { uid: "owner" };
  } }));
  const req = { headers: { authorization: "Bearer valid" }, requireFirebaseRevocationCheck: true };
  assert.equal(await verifyFirebaseToken(req, recorder()), "owner");
  assert.equal(await verifyFirebaseToken(req, recorder()), "owner");
  assert.equal(req.firebaseRevocationChecked, true);
  assert.equal(calls, 1);
  assert.equal(await verifyFirebaseToken({ headers: req.headers }, recorder(), { checkRevoked: true }), "owner");
  assert.equal(calls, 2);
});

test("missing token never trusts an identity cache without a revocation check", async () => {
  const req = { headers: {}, requireFirebaseRevocationCheck: true, verifiedFirebaseToken: { uid: "owner" } };
  const res = recorder();
  assert.equal(await verifyFirebaseToken(req, res), null);
  assert.equal(res.statusCode, 401);
});

test("signed sessions require an object and a finite future expiration", () => {
  const secret = "test-only-secret-for-session-validation";
  for (const payload of [null, [], {}, { exp: null }, { exp: "9999999999999" }, { exp: Date.now() - 1 }]) {
    assert.equal(verifySignedToken(signPayload(payload, secret), secret).valid, false);
  }
  assert.equal(verifySignedToken(signPayload({ exp: Date.now() + 60_000 }, secret), secret).valid, true);
});
