"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const crypto = require("node:crypto");
const router = require("../routes/workplace-support");
const s = require("../services/workplace-support");
const secret = "support-route-test-secret-32-characters";

// Deterministic Firestore substitute, including serializable transactions and
// query limits, used to exercise the actual HTTP router and authorization.
function database() {
  const records = new Map();
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const snapshot = ref => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => copy(records.get(ref.path)) });
  function doc(path) {
    return { path, id: path.split("/").at(-1), get: async () => snapshot(doc(path)),
      set: async value => records.set(path, copy(value)),
      create: async value => { if (records.has(path)) throw new Error("already-exists"); records.set(path, copy(value)); } };
  }
  function query(name, filters = [], maximum = Infinity, cursor = null) {
    return { doc: id => doc(`${name}/${id || crypto.randomUUID()}`),
      where: (key, op, value) => { assert.equal(op, "=="); return query(name, [...filters, [key, value]], maximum, cursor); },
      limit: limit => query(name, filters, limit, cursor), orderBy: () => query(name, filters, maximum, cursor),
      startAfter: id => query(name, filters, maximum, id),
      get: async () => ({ docs: [...records.keys()].filter(path => path.startsWith(`${name}/`) && path.split("/").length === 2)
        .sort().map(path => snapshot(doc(path))).filter(snap => (!cursor || snap.id > cursor) && filters.every(([key, val]) => snap.data()[key] === val)).slice(0, maximum) }) };
  }
  let pending = Promise.resolve();
  const db = { collection: name => query(name), records,
    runTransaction: fn => {
      const result = pending.then(async () => {
        const writes = [];
        const value = await fn({ get: ref => ref.get(), create: (ref, data) => writes.push(() => ref.create(data)),
          set: (ref, data) => writes.push(() => ref.set(data)) });
        for (const write of writes) await write();
        return value;
      });
      pending = result.catch(() => {});
      return result;
    },
    batch: () => { const paths = []; return { delete: ref => paths.push(ref.path), commit: async () => paths.forEach(path => records.delete(path)) }; }
  };
  return db;
}
async function setup(t) {
  const db = database();
  const set = (name, id, value) => db.collection(name).doc(id).set(value);
  await set("therapy_empresas", "acme", { nome: "Acme", status: "ativa" });
  await set("therapy_empresas", "other", { nome: "Other", status: "ativa" });
  for (const uid of ["ana", "bia"]) await set("therapy_colaboradores", uid, { email: `${uid}@example.test`, empresaId: "acme", status: "ativo", eligibilityVerifiedAt: 1, benefitEligible: true, patientAccountUid: uid });
  await set(s.CONFIG_COLLECTION, "acme", { config: { ...s.DEFAULT_CONFIG, enabled: true, careEnabled: true,
    companyEnabled: true, careOwnerName: "Equipe de acolhimento", companyOwnerName: "Equipe de pessoas", contact: "Canal de apoio" } });
  const app = express();
  app.use(express.json());
  app.use(router({ getDb: () => db, ensureDb: () => true, secret,
    verifyFirebaseToken: async (req, res) => { const uid = req.get("x-user"); if (!uid) { res.status(401).json({ error: "AUTH" }); return null; } return uid; },
    getUser: async uid => ({ emailVerified: uid !== "unverified", email: `${uid}@example.test`, displayName: uid }),
    verificarEmpresaToken: token => token ? { empresaId: token.split(":")[0], iat: Number(token.split(":")[1] || 100) } : null,
    verifyAdminTherapy: async (req, res) => { if (req.get("x-admin") === "yes") return { email: "admin@example.test" }; res.status(403).json({ error: "ADMIN" }); return null; }
  }));
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (path, { method = "GET", user, company, admin, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
      "Content-Type": "application/json", ...(user ? { "x-user": user } : {}), ...(company ? { Authorization: `Bearer ${company}` } : {}), ...(admin ? { "x-admin": "yes" } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const create = (recipient = "care", extra = {}, user = "ana") => call("/therapy/paciente/apoio/requests", { method: "POST", user,
    body: { requestId: crypto.randomUUID(), companyId: "acme", category: "overload", recipient, text: "Preciso conversar sobre minha situação.",
      need: "Organizar uma conversa", consent: true, aggregateConsent: false, ...extra } });
  return { db, set, call, create };
}
test("HTTP support enforces verified identity, eligibility, patient UID and configured service", async t => {
  const { set, call, create } = await setup(t);
  assert.equal((await call("/therapy/paciente/apoio/context")).status, 401);
  assert.equal((await call("/therapy/paciente/apoio/context", { user: "unverified" })).status, 403);
  assert.equal((await create("care", {}, "unknown")).status, 403);
  await set("therapy_colaboradores", "ana", { email: "ana@example.test", empresaId: "acme", status: "ativo", eligibilityVerifiedAt: 1, patientAccountUid: "other-account" });
  assert.equal((await create()).status, 403);
  await set(s.CONFIG_COLLECTION, "acme", { config: s.DEFAULT_CONFIG });
  assert.equal((await create("care", {}, "bia")).status, 409);
  assert.equal((await create("company", { companyId: "other" }, "bia")).status, 403);
});
test("HTTP support isolates company, care team and employee while preserving owner history after unlink", async t => {
  const { db, set, call, create } = await setup(t);
  const care = (await create()).body.item;
  const corporate = (await create("company")).body.item;
  const companyList = await call("/empresa/apoio/requests", { company: "acme" });
  assert.deepEqual(companyList.body.items.map(i => i.id), [corporate.id]);
  assert.equal((await call(`/empresa/apoio/requests/${care.id}`, { company: "acme" })).status, 404);
  assert.equal((await call(`/empresa/apoio/requests/${corporate.id}`, { company: "other" })).status, 404);
  assert.equal((await call(`/therapy/paciente/apoio/requests/${care.id}`, { user: "bia" })).status, 404);
  assert.equal((await call(`/therapy/admin/apoio/requests/${corporate.id}`, { admin: true })).status, 404);
  assert.equal((await call(`/therapy/admin/apoio/requests/${care.id}`)).status, 403);
  assert.equal((await call(`/therapy/admin/apoio/requests/${care.id}`, { admin: true })).status, 200);
  await set("therapy_colaboradores", "ana", { email: "ana@example.test", status: "inativo" });
  assert.equal((await call(`/therapy/paciente/apoio/requests/${care.id}`, { user: "ana" })).status, 200);
  assert.equal((await create()).status, 403);
  const stored = db.records.get(`${s.COLLECTION}/${care.id}`);
  assert.ok(!JSON.stringify(stored).includes("Preciso conversar"));
});
test("HTTP support create is idempotent and concurrent writes reject stale versions", async t => {
  const { call, create } = await setup(t);
  const requestId = crypto.randomUUID();
  const first = await create("care", { requestId });
  const retry = await create("care", { requestId });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(first.body.item.id, retry.body.item.id);
  assert.equal((await create("company", { requestId })).status, 409);
  const id = first.body.item.id;
  const responses = await Promise.all(["Primeira mensagem", "Segunda mensagem"].map(text =>
    call(`/therapy/paciente/apoio/requests/${id}/messages`, { method: "POST", user: "ana", body: { version: 1, text } })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const current = await call(`/therapy/paciente/apoio/requests/${id}`, { user: "ana" });
  assert.equal(current.body.item.version, 2);
  assert.equal(current.body.item.messages.length, 1);
  assert.equal(current.body.item.events.length, 2);
});
test("HTTP company password revocation, admin-only care config, pagination and public actions", async t => {
  const { set, call, create } = await setup(t);
  await create(); await create();
  const first = await call("/therapy/paciente/apoio/requests?limit=1", { user: "ana" });
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.nextCursor);
  const second = await call(`/therapy/paciente/apoio/requests?limit=1&cursor=${first.body.nextCursor}`, { user: "ana" });
  assert.equal(second.body.items.length, 1);
  assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  assert.equal(second.body.nextCursor, null);
  assert.equal((await call("/empresa/apoio/config", { method: "PUT", company: "acme", body: { careEnabled: false } })).status, 403);
  assert.equal((await call("/therapy/admin/apoio/companies/acme/config", { method: "PUT", admin: true, body: { careEnabled: false } })).status, 200);
  const action = await call("/empresa/apoio/actions", { method: "POST", company: "acme", body: {
    title: "Revisão das rotinas", ownerName: "Equipe de pessoas", dueDate: "2026-12-01", status: "planned", description: "Reorganizar tarefas" } });
  assert.equal(action.status, 201);
  assert.equal((await call("/therapy/paciente/apoio/actions?companyId=acme", { user: "ana" })).body.items.length, 1);
  assert.equal((await call("/therapy/paciente/apoio/actions?companyId=other", { user: "ana" })).status, 403);
  assert.equal((await call(`/empresa/apoio/actions/${action.body.item.id}`, { method: "PATCH", company: "other", body: { version: 1, status: "done" } })).status, 404);
  await set("therapy_empresas", "acme", { status: "ativa", passwordChangedAt: 200 });
  assert.equal((await call("/empresa/apoio/requests", { company: "acme:100" })).status, 401);
  await set("therapy_empresas", "acme", { status: "inativa" });
  assert.equal((await call("/empresa/apoio/requests", { company: "acme:300" })).status, 403);
});
test("HTTP monthly summaries are immutable and account cleanup deletes all private requests", async t => {
  const { db, set, call, create } = await setup(t);
  const initial = (await create()).body.item;
  const period = s.closedPeriod();
  const template = s.open(initial.id, db.records.get(`${s.COLLECTION}/${initial.id}`), secret);
  for (let i = 0; i < 10; i++) {
    const item = { ...template, id: `month${i}`, ownerKey: s.ownerKey(`person${i}`), aggregateConsent: true, createdAt: period.start + 1000 };
    await set(s.COLLECTION, item.id, s.seal(item, secret));
  }
  const report = await call("/empresa/apoio/summary", { company: "acme" });
  assert.equal(report.body.summary.total, 10);
  assert.equal(report.body.summary.suppressed, false);
  const extra = { ...template, id: "late", ownerKey: s.ownerKey("extra"), aggregateConsent: true, createdAt: period.start + 2000 };
  await set(s.COLLECTION, extra.id, s.seal(extra, secret));
  assert.deepEqual((await call("/empresa/apoio/summary", { company: "acme" })).body, report.body);
  assert.ok(!JSON.stringify(report.body).includes(template.text));
  assert.ok(!JSON.stringify(report.body).includes("ana@example.test"));
  assert.equal(await s.deleteForAccount(db, "ana"), 1);
  assert.equal((await call(`/therapy/paciente/apoio/requests/${initial.id}`, { user: "ana" })).status, 404);
});
