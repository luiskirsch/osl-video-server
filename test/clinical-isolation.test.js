"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const source = fs.readFileSync(path.join(__dirname, "../routes/therapy.js"), "utf8");
const handlers = new Map();
walk.simple(acorn.parse(source, { ecmaVersion: "latest" }), {
  CallExpression(node) {
    if (node.callee.type !== "MemberExpression" || node.callee.object.name !== "router") return;
    const route = node.arguments[0]?.value;
    if (typeof route !== "string") return;
    const wrapper = node.arguments.at(-1);
    if (wrapper.type === "CallExpression" && wrapper.callee.name === "asyncHandler") {
      const callback = wrapper.arguments[0];
      handlers.set(node.callee.property.name + " " + route, source.slice(callback.start, callback.end));
    }
  }
});
function recorder() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(method, route, uid, getDb) {
  const callback = handlers.get(method + " " + route);
  assert.ok(callback, route);
  return vm.runInNewContext("(" + callback + ")", {
    ensureDb: () => true, verifyFirebaseToken: async () => uid, getDb,
    sendError: (res, status, error) => res.status(status).json({ ok: false, error })
  });
}

test("another therapist, patient, game user, or employer cannot read a professional patient record", async () => {
  const database = () => ({ collection(name) {
    assert.equal(name, "therapy_patients");
    return { doc: id => {
      assert.equal(id, "patient-record-a");
      return { get: async () => ({ exists: true, data: () => ({ therapistUid: "therapist-a", ciphertext: "private" }) }) };
    } };
  } });
  for (const actor of ["therapist-b", "patient-a", "game-user", "employer"]) {
    const res = recorder();
    await handler("get", "/therapy/pacientes/:patientId", actor, database)({ params: { patientId: "patient-record-a" }, query: { uid: "therapist-a" } }, res);
    assert.equal(res.statusCode, 403, actor);
    assert.doesNotMatch(JSON.stringify(res.body), /private/);
  }
  const res = recorder();
  await handler("get", "/therapy/pacientes/:patientId", "therapist-a", database)({ params: { patientId: "patient-record-a" } }, res);
  assert.equal(res.statusCode, 200);
});

test("unauthorized session-note reads stop before querying clinical notes", async () => {
  for (const uid of ["therapist-b", "patient-a", "game-user", "employer"]) {
    const res = recorder();
    await handler("get", "/therapy/sessao/:sessionId/notas", uid, () => ({ collection(name) {
      assert.equal(name, "therapy_sessions", "clinical notes must not be queried");
      return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ therapistUid: "therapist-a" }) }) }) };
    } }))({ params: { sessionId: "session-a" } }, res);
    assert.equal(res.statusCode, 403);
  }
});

test("patient-note queries enforce authenticated ownership even when a foreign session is submitted", async () => {
  const seed = [
    { patientAccountUid: "patient-a", sessionId: "session-a", noteId: "note-a", ciphertext: "own" },
    { patientAccountUid: "patient-b", sessionId: "session-b", noteId: "note-b", ciphertext: "foreign" }
  ];
  const database = () => ({ collection(name) {
    assert.equal(name, "therapy_patient_notes");
    let records = seed;
    return {
      where(field, op, value) { assert.equal(op, "=="); records = records.filter(row => row[field] === value); return this; },
      limit() { return this; },
      async get() { return { docs: records.map(data => ({ data: () => data })) }; }
    };
  } });
  const run = handler("get", "/therapy/paciente/notas", "patient-a", database);
  const foreign = recorder(); await run({ query: { sessionId: "session-b", uid: "patient-b" } }, foreign);
  assert.equal(foreign.body.notes.length, 0);
  const own = recorder(); await run({ query: {} }, own);
  assert.equal(own.body.notes.length, 1); assert.equal(own.body.notes[0].noteId, "note-a");
});
