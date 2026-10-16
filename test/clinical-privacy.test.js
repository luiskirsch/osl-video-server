"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createRouter = require("../routes/clinicalPrivacy");

function fixture({ uid = "owner", registered = true, existing = false, failure = false } = {}) {
  const writes = [];
  const router = createRouter({
    authenticate: async (req, res, options) => {
      assert.equal(options.checkRevoked, true);
      if (!uid) { res.status(401).json({ error: "TOKEN_INVALIDO" }); return null; }
      req.verifiedFirebaseToken = { uid, email: "owner@example.invalid" };
      return uid;
    },
    ensureDb: () => true,
    getDb: () => ({ collection(name) { return { doc(id) {
      assert.equal(id, "owner");
      return {
        get: async () => ({ exists: registered && name === "therapy_patient_accounts" }),
        create: async data => {
          assert.equal(name, "therapy_deletion_requests");
          if (existing) throw Object.assign(new Error("already exists"), { code: 6 });
          if (failure) throw new Error("database offline");
          writes.push(data);
        }
      };
    } }; } })
  });
  const handler = router.stack.find(layer => layer.route).route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { writes, res, async call(body = {}) {
    let error;
    await handler({ body, headers: {} }, res, value => { error = value; });
    return error;
  } };
}

test("deletion request uses authenticated identity, never a submitted target UID", async () => {
  const f = fixture();
  await f.call({ uid: "another-patient", status: "approved" });
  assert.equal(f.res.statusCode, 403);
  assert.equal(f.writes.length, 0);
});
test("a game-only account or anonymous caller cannot create a clinical deletion request", async () => {
  for (const options of [{ uid: null }, { registered: false }]) {
    const f = fixture(options); await f.call();
    assert.ok([401, 403].includes(f.res.statusCode)); assert.equal(f.writes.length, 0);
  }
});
test("own request is recorded for review without executing account deletion", async () => {
  const f = fixture(); await f.call({ email: "owner@example.invalid", status: "approved" });
  assert.equal(f.res.statusCode, 202);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].uid, "owner");
  assert.equal(f.writes[0].status, "pending");
});
test("repeated requests preserve review status; storage failure is never acknowledged as success", async () => {
  const repeat = fixture({ existing: true }); await repeat.call();
  assert.equal(repeat.res.statusCode, 202); assert.equal(repeat.writes.length, 0);
  const failed = fixture({ failure: true });
  assert.ok(await failed.call() instanceof Error);
  assert.equal(failed.res.body, undefined);
});
