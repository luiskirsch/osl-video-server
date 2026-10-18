"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { registerChartRoutes, encryptedInput } = require("../routes/therapy-chart");
const encrypted = { ciphertext: Buffer.from("synthetic encrypted record content").toString("base64"), iv: Buffer.alloc(12, 3).toString("base64") };
const base = "/therapy/pacientes/:patientId/prontuario";

function fixture() {
  const data = new Map([["therapy_patients/pat_a", { therapistUid: "owner", revision: 0 }]]);
  const routes = new Map(), audits = [];
  let now = 1_800_000_000_000;
  function ref(path) {
    return { path, id: path.split("/").at(-1), collection: name => collection(path + "/" + name),
      async get() { return { exists: data.has(path), id: path.split("/").at(-1), ref: this, data: () => data.get(path) }; } };
  }
  function collection(path) {
    let count = Infinity, cursor = null;
    return { doc: id => ref(path + "/" + id), orderBy() { return this; }, limit(value) { count = value; return this; },
      startAfter(doc) { cursor = doc.id; return this; }, async get() {
        let docs = await Promise.all([...data.keys()].filter(key => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/")).map(key => ref(key).get()));
        docs.sort((a, b) => b.data().createdAt - a.data().createdAt);
        if (cursor) docs = docs.slice(docs.findIndex(doc => doc.id === cursor) + 1);
        return { docs: docs.slice(0, count) };
      } };
  }
  const db = { collection, async runTransaction(callback) {
    const writes = [];
    const outcome = await callback({ get: doc => doc.get(), set: (doc, value) => writes.push([doc.path, value]),
      create(doc, value) { assert.equal(data.has(doc.path), false); writes.push([doc.path, value]); } });
    for (const [key, value] of writes) data.set(key, value);
    return outcome;
  } };
  const router = Object.fromEntries(["get", "put", "post"].map(method => [method, (path, handler) => routes.set(method + " " + path, handler)]));
  registerChartRoutes(router, { asyncHandler: handler => handler, ensureDb: () => true, getDb: () => db,
    verifyFirebaseToken: async (req, res) => { if (!req.actor) res.status(401).json({ ok: false }); return req.actor; },
    sendError: (res, status, error) => res.status(status).json({ ok: false, error }), timestamp: () => ++now, logAudit: async event => audits.push(event) });
  return { data, audits, async call(method, suffix = "", body = {}, { actor = "owner", query = {} } = {}) {
    const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; },
      set(key, value) { this.headers[key] = value; }, json(body) { this.body = body; return this; } };
    await routes.get(method + " " + base + suffix)({ actor, params: { patientId: "pat_a" }, body, query }, res);
    return res;
  } };
}

test("clinical context and entries reject anonymous, foreign and deleted-patient access", async () => {
  const f = fixture();
  for (const method of ["get", "put", "post"]) {
    const suffix = method === "post" ? "/registros" : "";
    for (const actor of [null, "other-professional", "patient", "employer"]) {
      const res = await f.call(method, suffix, { ...encrypted, expectedVersion: 0, requestId: "req_one" }, { actor });
      assert.equal(res.statusCode, actor ? 403 : 401);
      assert.equal(res.body.ciphertext, undefined);
    }
  }
  f.data.set("therapy_patients/pat_a", { therapistUid: "owner", deleted: true });
  assert.equal((await f.call("get")).statusCode, 404);
  assert.equal(f.audits.length, 0);
});

test("context updates preserve encrypted prior versions and reject stale tabs", async () => {
  const f = fixture();
  assert.equal((await f.call("get")).body.version, 0);
  assert.equal((await f.call("put", "", { ...encrypted, expectedVersion: 0 })).body.version, 1);
  const stale = await f.call("put", "", { ...encrypted, expectedVersion: 0 });
  assert.equal(stale.statusCode, 409);
  assert.equal((await f.call("put", "", { ...encrypted, expectedVersion: 1 })).body.version, 2);
  assert.deepEqual(f.data.get("therapy_patients/pat_a/chart_versions/1").ciphertext, encrypted.ciphertext);
  const response = await f.call("get");
  assert.match(response.headers["Cache-Control"], /no-store/);
  assert.equal(response.body.version, 2);
  assert.ok(f.audits.every(item => !JSON.stringify(item).includes(encrypted.ciphertext)));
});

test("ciphertext and expected versions are mandatory and bounded", async () => {
  assert.equal(encryptedInput({ ciphertext: "plain clinical text", iv: encrypted.iv }), null);
  assert.equal(encryptedInput({ ...encrypted, iv: "bad" }), null);
  assert.equal(encryptedInput({ ...encrypted, ciphertext: "a".repeat(300_000) }), null);
  const f = fixture();
  for (const expectedVersion of [undefined, -1, "0", 1.5]) {
    assert.equal((await f.call("put", "", { ...encrypted, expectedVersion })).statusCode, 400);
  }
});

test("new entries are idempotent, immutable, and supplements retain the original", async () => {
  const f = fixture();
  const body = { ...encrypted, kind: "soap", requestId: "req_one" };
  const first = await f.call("post", "/registros", body);
  assert.equal(first.statusCode, 200);
  assert.equal((await f.call("post", "/registros", body)).body.alreadySaved, true);
  assert.equal(f.audits.length, 1);
  assert.equal((await f.call("post", "/registros", { ...body, ciphertext: Buffer.from("different encrypted content value").toString("base64") })).statusCode, 409);
  const addition = await f.call("post", "/registros", { ...encrypted, requestId: "req_two", kind: "addendum", parentEntryId: first.body.entryId });
  assert.equal(addition.statusCode, 200);
  const list = await f.call("get", "/registros");
  assert.equal(list.body.entries.length, 2);
  assert.equal(list.body.entries[0].parentEntryId, first.body.entryId);
  assert.equal(list.body.entries[1].ciphertext, encrypted.ciphertext);
});

test("entries cannot link another professional's or patient's session", async () => {
  const f = fixture();
  for (const session of [{ therapistUid: "other", patientId: "pat_a" }, { therapistUid: "owner", patientId: "pat_b" }]) {
    f.data.set("therapy_sessions/sess_one", session);
    assert.equal((await f.call("post", "/registros", { ...encrypted, requestId: "one", sessionId: "sess_one" })).statusCode, 403);
  }
  f.data.set("therapy_sessions/sess_one", { therapistUid: "owner", patientId: "pat_a" });
  assert.equal((await f.call("post", "/registros", { ...encrypted, requestId: "one", sessionId: "sess_one" })).statusCode, 200);
  assert.equal((await f.call("post", "/registros", { ...encrypted, requestId: "two", parentEntryId: "foreign_entry", kind: "addendum" })).statusCode, 404);
});

test("pagination loads every entry once and validates cursor and page size", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.call("post", "/registros", { ...encrypted, requestId: "req_" + i });
  const first = (await f.call("get", "/registros", {}, { query: { limit: "3" } })).body;
  assert.equal(first.entries.length, 3);
  const second = (await f.call("get", "/registros", {}, { query: { limit: "3", cursor: first.nextCursor } })).body;
  assert.equal(second.entries.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.entryId)).size, 5);
  assert.equal((await f.call("get", "/registros", {}, { query: { limit: "2.5" } })).statusCode, 400);
  assert.equal((await f.call("get", "/registros", {}, { query: { cursor: "unknown" } })).statusCode, 400);
});

test("patient revision guard prevents overwrites and legacy writes still advance the revision", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/therapy.js"), "utf8");
  let callback;
  walk.simple(acorn.parse(source, { ecmaVersion: "latest" }), { CallExpression(node) {
    if (node.callee.type !== "MemberExpression" || node.callee.object.name !== "router" || node.callee.property.name !== "patch" || node.arguments[0]?.value !== "/therapy/pacientes/:patientId") return;
    const handler = node.arguments.at(-1).arguments[0]; callback = source.slice(handler.start, handler.end);
  } });
  let patient = { therapistUid: "owner", revision: 2, ciphertext: "original" };
  const ref = {};
  const db = { collection: () => ({ doc: () => ref }), runTransaction: async handler => handler({
    get: async () => ({ exists: true, data: () => patient }), set: (_, updates) => { patient = { ...patient, ...updates }; }
  }) };
  const run = vm.runInNewContext("(" + callback + ")", { ensureDb: () => true, verifyFirebaseToken: async () => "owner", getDb: () => db,
    PATIENT_CIPHERTEXT_MAX: 65536, admin: { firestore: { FieldValue: { serverTimestamp: () => 1000 } } }, logAudit: async () => {},
    sendError: (res, status, error) => res.status(status).json({ ok: false, error }) });
  const response = () => ({ statusCode: 200, status(status) { this.statusCode = status; return this; }, json(body) { this.body = body; return this; } });
  const stale = response();
  await run({ params: { patientId: "pat_a" }, body: { ...encrypted, expectedRevision: 1 } }, stale);
  assert.equal(stale.statusCode, 409); assert.equal(patient.ciphertext, "original");
  const fresh = response();
  await run({ params: { patientId: "pat_a" }, body: { ...encrypted, expectedRevision: 2 } }, fresh);
  assert.equal(fresh.body.revision, 3);
  const legacy = response();
  await run({ params: { patientId: "pat_a" }, body: encrypted }, legacy);
  assert.equal(legacy.body.revision, 4);
});
