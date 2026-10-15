"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../routes/therapy.js"), "utf8");
const start = source.indexOf('router.post("/therapy/profissional/conta/encerrar"');
const route = source.slice(start, source.indexOf("\n}));", start) + 5);

async function close({ uid = "owner", confirmation = "ENCERRAR", therapist = {}, payment = "ok" } = {}) {
  const calls = [];
  let handler;
  const context = {
    router: { post: (_path, fn) => { handler = fn; } },
    asyncHandler: fn => fn,
    ensureDb: () => true,
    verifyFirebaseToken: async () => uid,
    loadTherapist: async () => therapist,
    sendError: (res, status, error) => { res.status = status; res.error = error; },
    mercadoPagoFetchTherapy: async () => {
      calls.push("payment");
      if (payment === "throw") throw new Error("offline");
      return { response: { ok: payment === "ok" } };
    },
    getDb: () => ({ collection: name => {
      assert.equal(name, "therapists");
      return { doc: target => {
        assert.equal(target, "owner");
        return { set: async () => calls.push("save"), delete: async () => calls.push("delete") };
      } };
    } }),
    logAudit: async () => calls.push("audit"),
    logError: () => {},
    encodeURIComponent
  };
  vm.runInNewContext(route, context);
  const res = { json: body => { res.body = body; } };
  await handler({ body: { confirmation, uid: "someone-else" } }, res);
  return { calls, res };
}

test("closure requires authentication and explicit confirmation", async () => {
  assert.deepEqual((await close({ uid: null })).calls, []);
  const result = await close({ confirmation: "" });
  assert.equal(result.res.status, 400);
  assert.deepEqual(result.calls, []);
});
test("payment failures preserve the professional profile", async () => {
  for (const payment of ["throw", "failed"]) {
    const result = await close({ therapist: { mpPreapprovalId: "sub" }, payment });
    assert.ok(result.res.status >= 500);
    assert.deepEqual(result.calls, ["payment"]);
  }
});
test("closure cancels billing before deleting only the authenticated professional profile", async () => {
  const result = await close({ therapist: { mpPreapprovalId: "sub" } });
  assert.deepEqual(result.calls, ["payment", "save", "audit", "delete"]);
  assert.equal(result.res.body.ok, true);
});
test("trial and already cancelled accounts can close without payment calls", async () => {
  for (const therapist of [{}, { mpPreapprovalId: "sub", mpPreapprovalStatus: "cancelled" }]) {
    assert.deepEqual((await close({ therapist })).calls, ["audit", "delete"]);
  }
});
