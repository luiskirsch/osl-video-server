"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const crypto = require("node:crypto");
const roster = require("../services/corporate-roster");
const createRouter = require("../routes/corporate-roster");

function database() {
  const records = new Map(), copy = x => x === undefined ? undefined : structuredClone(x);
  function doc(path) {
    const ref = { id: path.split("/").at(-1), path };
    ref.get = async () => ({ id: ref.id, ref, exists: records.has(path), data: () => copy(records.get(path)) });
    ref.set = async data => records.set(path, copy(data));
    return ref;
  }
  function query(name, filters = [], max = Infinity, cursor = null) {
    return { doc: id => doc(`${name}/${id}`), where: (key, op, value) => { assert.equal(op, "=="); return query(name, [...filters, [key, value]], max, cursor); },
      orderBy: () => query(name, filters, max, cursor), limit: n => query(name, filters, n, cursor), select() { return this; },
      startAfter: value => query(name, filters, max, value.id || value),
      get: async () => ({ docs: await Promise.all([...records.keys()].sort().filter(path => path.startsWith(`${name}/`) && path.split("/").length === 2
        && (!cursor || path.split("/").at(-1) > cursor) && filters.every(([key, value]) => records.get(path)[key] === value))
        .slice(0, max).map(path => doc(path).get())) }) };
  }
  let pending = Promise.resolve();
  return { records, collection: name => query(name), runTransaction: fn => {
    const result = pending.then(async () => {
      const writes = [];
      const value = await fn({ get: ref => ref.get(), create: (ref, value) => { assert.ok(!records.has(ref.path)); writes.push(() => ref.set(value)); },
        set: (ref, value) => writes.push(() => ref.set(value)), update: (ref, value) => writes.push(() => ref.set({ ...records.get(ref.path), ...value })) });
      for (const write of writes) await write();
      return value;
    }); pending = result.catch(() => {}); return result;
  } };
}
async function setup(t, capacity = 20) {
  const db = database();
  const set = (name, id, data) => db.collection(name).doc(id).set(data);
  await set("therapy_empresas", "acme", { nome: "Acme", status: "ativa", benefitStatus: "active", loginEmail: "rh@acme.test", slug: "acme", limiteColaboradores: capacity });
  await set("therapy_empresas", "other", { nome: "Outra", status: "ativa", benefitStatus: "active" });
  const app = express(); app.use(express.json());
  app.use(createRouter({ getDb: () => db, ensureDb: () => true,
    verificarEmpresaToken: token => token ? { empresaId: token.split(":")[0], iat: Number(token.split(":")[1] || 100) } : null }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (path = "", { company = "acme", method = "GET", body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/empresa/colaboradores${path}`, {
      method, headers: { "Content-Type": "application/json", ...(company ? { Authorization: `Bearer ${company}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const create = (email = "ana@example.test", extra = {}) => call("", { method: "POST", body: { nome: "Ana Silva", email, ...extra } });
  return { db, set, call, create };
}
test("HR routes enforce company identity, revoked passwords and tenant isolation with explicit safe projections", async t => {
  const { call, create, set } = await setup(t);
  assert.equal((await call("", { company: null })).status, 401);
  const created = await create(); const id = created.body.item.id;
  assert.equal(created.status, 201);
  assert.equal((await call("", { company: "other" })).body.items.length, 0);
  assert.equal((await call(`/${id}`, { company: "other", method: "PATCH", body: { version: created.body.item.version, nome: "Intruso" } })).status, 404);
  await set(roster.MEMBERS, "private", { empresaId: "acme", nome: "Privada", email: "private@example.test", cpf: "sensitive", clinicalNotes: "secret", patientAccountUid: "secret-uid" });
  assert.doesNotMatch(JSON.stringify((await call()).body), /sensitive|secret/);
  await set("therapy_empresas", "acme", { status: "ativa", passwordChangedAt: 200 });
  assert.equal((await call()).status, 401);
  await set("therapy_empresas", "acme", { status: "inativa" });
  assert.equal((await call()).status, 403);
});
test("admission, approval, offboarding and readmission preserve account, history, sessions and immutable audit", async t => {
  const { db, set, call, create } = await setup(t);
  let item = (await create()).body.item;
  assert.equal(item.status, "pendente"); assert.equal(item.benefitEligible, false);
  const patch = body => call(`/${item.id}`, { method: "PATCH", body: { version: item.version, ...body } });
  assert.equal((await patch({ action: "approve" })).status, 400);
  item = (await patch({ action: "approve", employmentType: "clt", confirmEligibility: true })).body.item;
  assert.equal(item.benefitEligible, true);
  assert.equal((await patch({ employmentType: "" })).status, 400);
  const stale = item.version;
  await set("therapy_sessions", "existing", { status: "scheduled", colaboradorId: item.id });
  await set("therapy_patient_accounts", "patient", { name: "Ana", privateHistory: "preserved" });
  item = (await patch({ nome: "Ana Atualizada", status: "inativo", empresaId: "other", patientAccountUid: "attacker" })).body.item;
  assert.equal(item.status, "ativo");
  assert.equal(db.records.get(`${roster.MEMBERS}/${item.id}`).empresaId, "acme");
  assert.equal((await call(`/${item.id}`, { method: "PATCH", body: { version: stale, nome: "Perdida" } })).status, 409);
  item = (await patch({ action: "deactivate", departureDate: "2026-01-01", departureReason: "demissao", confirmDeactivation: true })).body.item;
  assert.equal(item.status, "inativo"); assert.equal(item.benefitEligible, false);
  assert.equal(db.records.get("therapy_sessions/existing").status, "scheduled");
  assert.equal(db.records.get("therapy_patient_accounts/patient").privateHistory, "preserved");
  item = (await patch({ action: "reactivate", employmentType: "clt", admissionDate: "2026-02-01", confirmEligibility: true })).body.item;
  assert.equal(item.status, "ativo"); assert.equal(item.departureDate, null);
  const events = (await call("/movimentacoes")).body.items;
  assert.equal(events.length, 5); assert.ok(events.every(e => e.actor === "rh@acme.test"));
  assert.ok(events.some(e => e.type === "desligamento" && e.after.status === "inativo" && e.before.status === "ativo"));
});
test("capacity is atomic under concurrent admissions and released by offboarding without erasing registrations", async t => {
  const { create, call } = await setup(t, 1);
  const responses = await Promise.all([create("a@example.test"), create("b@example.test")]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const item = responses.find(r => r.status === 201).body.item;
  await call(`/${item.id}`, { method: "PATCH", body: { action: "deactivate", version: item.version, departureDate: "2026-01-01", departureReason: "fim_contrato", confirmDeactivation: true } });
  assert.equal((await create("c@example.test")).status, 201);
  const list = (await call()).body;
  assert.equal(list.summary.total, 2); assert.equal(list.summary.ocupadas, 1); assert.equal(list.summary.inativo, 1);
  const off = list.items.find(i => i.status === "inativo");
  assert.equal((await call(`/${off.id}`, { method: "PATCH", body: { action: "reactivate", version: off.version, employmentType: "clt", confirmEligibility: true } })).status, 409);
});
test("import previews duplicates and invalid dates, commits atomically and safely retries without duplicate events", async t => {
  const { call, create } = await setup(t);
  await create("old@example.test");
  const row = { nome: "Bruna Souza", email: "bruna@example.test", employmentType: "pj" };
  const preview = await call("/importar/preview", { method: "POST", body: { rows: [row, row, { ...row, email: "old@example.test" }, { ...row, admissionDate: "2026-02-30" }] } });
  assert.equal(preview.body.valid, false); assert.equal(preview.body.rows.filter(r => r.error).length, 3);
  const requestId = crypto.randomUUID();
  const send = rows => call("/importar", { method: "POST", body: { rows, requestId } });
  assert.equal((await send([row, { ...row, email: "old@example.test" }])).status, 409);
  assert.equal((await call()).body.summary.total, 1);
  assert.equal((await send([row])).status, 201);
  assert.equal((await send([row])).status, 200);
  assert.equal((await send([{ ...row, nome: "Diferente" }])).status, 409);
  assert.equal((await call()).body.summary.total, 2);
  assert.equal((await call("/movimentacoes")).body.items.length, 2);
});
test("activation requires a classified and confirmed relationship, and dates and filters are validated", async t => {
  const { call, create } = await setup(t);
  assert.equal((await create("bad@example.test", { status: "ativo" })).status, 400);
  assert.equal((await create("good@example.test", { status: "ativo", employmentType: "pj", confirmEligibility: true })).body.item.benefitEligible, true);
  assert.equal((await create("date@example.test", { admissionDate: "2099-01-01" })).status, 400);
  assert.equal((await call("?page=0")).status, 400);
  assert.equal((await call("?status=anything")).status, 400);
  assert.equal((await call("?q=ana&status=ativo")).body.total, 1);
});
