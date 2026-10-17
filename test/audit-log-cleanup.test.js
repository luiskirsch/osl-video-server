"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runAuditLogCleanup } = require("../jobs/auditLogCleanup");

test("limpeza de audit_logs remove só registros com mais de 6 meses (Marco Civil)", async () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const store = new Map([
    ["antigo", { time: "2026-03-01T00:00:00.000Z" }],
    ["cinco-meses", { time: "2026-05-20T00:00:00.000Z" }],
    ["recente", { time: "2026-10-16T00:00:00.000Z" }]
  ]);
  const db = {
    collection: () => ({ where: (_field, _op, cutoff) => ({ limit: n => ({ get: async () => {
      const docs = [...store].filter(([, d]) => d.time < cutoff).slice(0, n).map(([id]) => ({ ref: id }));
      return { empty: docs.length === 0, docs };
    } }) }) }),
    batch: () => { const refs = []; return { delete: ref => refs.push(ref), commit: async () => refs.forEach(ref => store.delete(ref)) }; }
  };
  assert.equal(await runAuditLogCleanup({ db, now }), 1);
  assert.deepEqual([...store.keys()], ["cinco-meses", "recente"]);
});

test("limpeza sem Firestore configurado não faz nada", async () => {
  assert.equal(await runAuditLogCleanup({ db: null }), 0);
});
