"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const firestore = require("../services/firestore");
const { auditLog } = require("../middleware/auditLog");

test("successful clinical reads persist an audit event with verified identity and no query secrets", async t => {
  const entries = [];
  t.mock.method(firestore, "getDb", () => ({ collection(name) {
    assert.equal(name, "audit_logs"); return { add: async row => { entries.push(row); } };
  } }));
  const req = { method: "GET", path: "/therapy/paciente/notas", originalUrl: "/therapy/paciente/notas?token=secret",
    headers: {}, firebaseUid: "verified-user", body: { clinicalText: "must never be logged" } };
  const res = new EventEmitter(); res.statusCode = 200;
  auditLog("clinical", { includeSuccessfulReads: true })(req, res, () => {});
  res.emit("finish");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].uid, "verified-user");
  assert.equal(entries[0].path, "/therapy/paciente/notas");
  assert.ok(entries[0].expireAt instanceof Date);
  assert.doesNotMatch(JSON.stringify(entries[0]), /secret|must never/);
});
