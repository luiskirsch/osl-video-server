"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

for (const [file, route] of [["admin.js", "/admin/delete-user"],
  ["therapy.js", "/therapy/admin/profissionais/:uid/excluir-definitivo"]]) {
  test(`${route}: falha ao excluir apoio preserva login para tentar novamente`, async () => {
    const source = fs.readFileSync(path.join(__dirname, "../routes", file), "utf8");
    const start = source.indexOf('router.post("' + route + '"');
    const body = source.slice(start, source.indexOf("\n}));", start) + 5);
    for (const failure of [false, true]) {
      const calls = [];
      let handler;
      const db = { collection: () => ({
        doc: () => ({ get: async () => ({ exists: false }) }),
        where() { return this; }, limit() { return this; },
        get: async () => ({ empty: true, docs: [] }),
      }) };
      vm.runInNewContext(body, {
        router: { post(_route, ...handlers) { handler = handlers.at(-1); } },
        asyncHandler: fn => fn, adminLimiter: () => {}, requireAdmin: () => {},
        ensureDb: () => true, getDb: () => db,
        verifyAdminTherapy: async () => ({ uid: "administrator" }),
        admin: { auth: () => ({
          getUserByEmail: async () => ({ uid: "owner" }),
          deleteUser: async uid => { calls.push("auth:" + uid); },
        }) },
        deleteDiaryForAccount: async () => 0,
        async deleteSupportForAccount(receivedDb, uid) {
          assert.equal(receivedDb, db); assert.equal(uid, "owner"); calls.push("support");
          if (failure) throw new Error("sensitive storage failure");
          return 12;
        },
        sendError: (res, status, error) => res.status(status).json({ ok: false, error }),
        logInfo: () => {}, logWarn: () => {}, logAudit: async () => {},
      });
      const res = { statusCode: 200, status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; } };
      await handler({ params: { uid: "owner" }, body: { email: "owner@example.test", confirmUid: "owner" } }, res);
      assert.deepEqual(calls, failure ? ["support"] : ["support", "auth:owner"]);
      assert.equal(res.statusCode, failure ? 503 : 200);
      if (failure) assert.equal(res.body.error, "APOIO_EXCLUSAO_FALHOU");
      assert.ok(!JSON.stringify(res.body).includes("sensitive storage failure"));
    }
  });
}
