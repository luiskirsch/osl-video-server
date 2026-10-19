"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const createDiaryRouter = require("../routes/diary");
const diary = require("../services/diary");

const SECRET = "synthetic-test-secret-for-personal-diary-32-bytes";
const BASE = "/therapy/paciente/diario";
const TODAY = "2026-10-18";
function entry(extra = {}) {
  return {
    kind: "diary", text: "Uma lembrança particular do parque.", date: TODAY,
    unlockDate: null, version: 0, feelings: ["nostalgia"], tags: ["parque"],
    aroma: "chuva", font: "hand", weather: "cloudy", ...extra,
  };
}

function database() {
  const data = new Map();
  let transactions = Promise.resolve();
  let failure = null;
  const ref = path => ({
    path, id: path.split("/").at(-1), collection: name => collection(path + "/" + name),
    async get() {
      if (failure) throw failure;
      const value = data.get(path);
      return { exists: data.has(path), id: this.id, ref: this, data: () => structuredClone(value) };
    },
  });
  function collection(path) {
    let count = Infinity, cursor = null;
    const orders = [];
    return {
      path, doc: id => ref(path + "/" + id),
      orderBy(field, direction) { orders.push([field, direction]); return this; },
      limit(value) { count = value; return this; },
      startAfter(at, id) { cursor = { at, id }; return this; },
      async get() {
        if (failure) throw failure;
        let docs = await Promise.all([...data.keys()]
          .filter(key => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"))
          .map(key => ref(key).get()));
        if (orders.length) {
          assert.deepEqual(orders, [["createdAt", "desc"], ["__name__", "desc"]]);
          docs.sort((a, b) => b.data().createdAt - a.data().createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        }
        if (cursor) docs = docs.filter(doc => doc.data().createdAt < cursor.at || (doc.data().createdAt === cursor.at && doc.id < cursor.id));
        return { docs: docs.slice(0, count) };
      },
    };
  }
  return {
    data, collection, failWith(error) { failure = error; },
    batch() {
      const deletes = [];
      return { delete(doc) { deletes.push(doc.path); }, async commit() {
        if (failure) throw failure;
        assert.ok(deletes.length <= 400);
        for (const path of deletes) data.delete(path);
      } };
    },
    runTransaction(callback) {
      const run = transactions.then(async () => {
        if (failure) throw failure;
        const writes = [];
        const result = await callback({
          get: doc => doc.get(),
          set(doc, value) { writes.push(() => data.set(doc.path, structuredClone(value))); },
          delete(doc) { writes.push(() => data.delete(doc.path)); },
        });
        for (const write of writes) write();
        return result;
      });
      transactions = run.catch(() => {});
      return run;
    },
  };
}

async function fixture(t, { secret = SECRET } = {}) {
  const db = database();
  let date = TODAY;
  let unavailable = false;
  const app = express();
  app.use(express.json());
  app.use(createDiaryRouter({
    verifyFirebaseToken: async (req, res) => {
      const uid = req.get("authorization")?.match(/^Bearer ([\w-]+)$/)?.[1];
      if (!uid) res.status(401).json({ ok: false, error: "AUTH_OBRIGATORIA" });
      return uid;
    },
    ensureDb: res => {
      if (unavailable) res.status(503).json({ ok: false, error: "BANCO_INDISPONIVEL" });
      return !unavailable;
    },
    getDb: () => db, secret, today: () => date,
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = "http://127.0.0.1:" + server.address().port + BASE;
  return {
    db, setDate(value) { date = value; }, setUnavailable(value) { unavailable = value; },
    seed(id, payload = entry(), { uid = "owner", at = 1000, version = 1 } = {}) {
      const path = diary.entriesFor(db, uid).doc(id).path;
      const record = { kind: payload.kind, date: payload.date, unlockDate: payload.unlockDate,
        version, createdAt: at, updatedAt: at, payload: diary.seal(uid, diary.normalize(payload, TODAY), secret) };
      db.data.set(path, record);
      return { path, record };
    },
    async call(method = "GET", suffix = "", body, uid = "owner") {
      const response = await fetch(url + suffix, {
        method,
        headers: { ...(uid ? { authorization: "Bearer " + uid } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test("diary rejects anonymous access and scopes reads, writes and deletes to the authenticated UID", async t => {
  const f = await fixture(t);
  for (const [method, suffix, body] of [["GET", ""], ["PUT", "/memo", entry()], ["DELETE", "/memo?version=1"]]) {
    const response = await f.call(method, suffix, body, null);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
  }
  const created = await f.call("PUT", "/memo", entry({ uid: "other", patientId: "other" }));
  assert.equal(created.status, 200);
  assert.equal(created.body.item.version, 1);
  assert.equal(created.body.item.text, entry().text);
  assert.equal((await f.call("GET", "?uid=owner&patientId=owner", undefined, "other")).body.items.length, 0);
  assert.equal((await f.call("DELETE", "/memo?version=1", undefined, "other")).status, 200);
  assert.equal((await f.call()).body.items.length, 1);
  assert.equal((await f.call("PUT", "/memo", entry(), "other")).status, 200);
  assert.equal(f.db.data.size, 2);
  const expected = crypto.createHash("sha256").update("owner").digest("hex");
  assert.ok(f.db.data.has("therapy_diaries/" + expected + "/entries/memo"));
});

test("stored content is encrypted per account with fresh IVs and authenticated tamper rejection", async t => {
  const f = await fixture(t);
  await f.call("PUT", "/memo", entry());
  const [path, stored] = [...f.db.data][0];
  assert.equal(stored.payload.algorithm, "AES-256-GCM");
  assert.equal(JSON.stringify(stored).includes(entry().text), false);
  assert.equal(JSON.stringify(stored).includes("nostalgia"), false);
  assert.equal(JSON.stringify(stored).includes("parque"), false);
  assert.equal(diary.open("owner", stored.payload, SECRET).text, entry().text);
  assert.throws(() => diary.open("other", stored.payload, SECRET));
  const independent = diary.seal("owner", entry(), SECRET);
  assert.notEqual(independent.iv, stored.payload.iv);
  const bytes = Buffer.from(stored.payload.ciphertext, "base64");
  bytes[0] ^= 1;
  f.db.data.set(path, { ...stored, payload: { ...stored.payload, ciphertext: bytes.toString("base64") } });
  const result = await f.call();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: "DIARIO_INDISPONIVEL" });
});

test("custom aromas are encrypted, restored and replaced by a preset without stale text", async t => {
  const f = await fixture(t);
  const aromaText = 'Bolo de fubá da minha avó <3';
  const created = await f.call("PUT", "/aroma", entry({ aroma: "", aromaText: `  ${aromaText}  ` }));
  assert.equal(created.status, 200);
  assert.equal(created.body.item.aromaText, aromaText);
  assert.equal((await f.call()).body.items[0].aromaText, aromaText);
  const stored = [...f.db.data.values()][0];
  assert.equal(JSON.stringify(stored).includes(aromaText), false);
  assert.equal(diary.open("owner", stored.payload, SECRET).aromaText, aromaText);
  const replaced = await f.call("PUT", "/aroma", entry({ version: 1, aroma: "lavanda", aromaText }));
  assert.equal(replaced.body.item.aroma, "lavanda");
  assert.equal(replaced.body.item.aromaText, "");
});

test("capsules omit every content field until the Sao Paulo unlock date and remain immutable", async t => {
  const f = await fixture(t);
  const capsule = entry({ kind: "capsule", unlockDate: "2026-10-20", aroma: "", aromaText: "Perfume de uma lembrança futura" });
  const created = await f.call("PUT", "/future", capsule);
  assert.equal(created.status, 200);
  const expectedKeys = ["id", "kind", "date", "unlockDate", "version", "createdAt", "updatedAt", "locked"].sort();
  assert.deepEqual(Object.keys(created.body.item).sort(), expectedKeys);
  assert.equal(created.body.item.locked, true);
  const listed = await f.call();
  assert.deepEqual(Object.keys(listed.body.items[0]).sort(), expectedKeys);
  assert.equal((await f.call("PUT", "/future", entry({ version: 1 }))).body.error, "CAPSULA_SELADA");
  f.setDate("2026-10-19");
  assert.equal((await f.call()).body.items[0].locked, true);
  f.setDate("2026-10-20");
  const opened = (await f.call()).body.items[0];
  assert.equal(opened.locked, false);
  assert.equal(opened.text, capsule.text);
  assert.equal(opened.aromaText, capsule.aromaText);
  assert.equal((await f.call("PUT", "/future", entry({ version: 1 }))).body.error, "CAPSULA_SELADA");
  assert.equal((await f.call("DELETE", "/future?version=1")).status, 200);
});

test("changing capsule release metadata cannot bypass authenticated locking", async t => {
  const f = await fixture(t);
  const { path, record } = f.seed("future", entry({ kind: "capsule", unlockDate: "2026-10-20" }));
  f.db.data.set(path, { ...record, unlockDate: "2026-10-17" });
  assert.equal((await f.call()).status, 503);
  f.db.data.set(path, { ...record, kind: "diary" });
  assert.equal((await f.call()).status, 503);
});

test("optimistic transactions reject concurrent/stale edits and stale deletes", async t => {
  const f = await fixture(t);
  const concurrent = await Promise.all([f.call("PUT", "/memo", entry()), f.call("PUT", "/memo", entry({ text: "Outra versão." }))]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  assert.equal(concurrent.find(response => response.status === 409).body.error, "REGISTRO_ALTERADO");
  const original = (await f.call()).body.items[0];
  const edited = await f.call("PUT", "/memo", entry({ version: 1, text: "Texto atualizado." }));
  assert.equal(edited.body.item.version, 2);
  assert.equal(edited.body.item.createdAt, original.createdAt);
  assert.ok(edited.body.item.updatedAt >= original.updatedAt);
  const stale = await f.call("DELETE", "/memo?version=1");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "REGISTRO_ALTERADO");
  assert.equal((await f.call()).body.items[0].text, "Texto atualizado.");
  assert.equal((await f.call("DELETE", "/memo?version=2")).status, 200);
  assert.equal((await f.call()).body.items.length, 0);
  assert.equal((await f.call("PUT", "/memo", entry({ version: 2 }))).status, 409);
});

test("entry validation rejects malformed dates, oversized fields, invalid enums and unsafe versions", async t => {
  const f = await fixture(t);
  const invalid = [
    { kind: "other" }, { text: "" }, { text: "  " }, { text: "a".repeat(20001) },
    { date: "2026-02-29" }, { date: "2026-13-18" }, { date: "2026-00-18" }, { date: "2026-10-32" },
    { date: "0000-01-01" }, { date: "2026-2-01" }, { date: "2026-10-18T00:00:00Z" }, { date: "2026-10-19" },
    { unlockDate: "2027-01-01" }, { kind: "capsule", unlockDate: null },
    { kind: "capsule", unlockDate: "2026-10-18" }, { kind: "capsule", unlockDate: "2026-02-30" },
    { version: -1 }, { version: "0" }, { version: 1.1 }, { version: Number.MAX_SAFE_INTEGER },
    { feelings: null }, { feelings: ["invalid"] }, { feelings: ["serenidade", "alegria", "gratidao", "nostalgia"] }, { tags: ["a".repeat(31)] }, { tags: Array(7).fill("tag") },
    { tags: [null] }, { aroma: "rosas" }, { aromaText: null }, { aromaText: 12 }, { aromaText: "a".repeat(101) }, { aromaText: "duas\nlinhas" }, { font: "serif" }, { weather: "sun" },
  ];
  for (const change of invalid) {
    const response = await f.call("PUT", "/invalid", entry(change));
    assert.equal(response.status, 400, JSON.stringify(change).slice(0, 100));
  }
  assert.equal(f.db.data.size, 0);
  const valid = await f.call("PUT", "/leap", entry({ date: "2024-02-29", tags: ["#parque", "parque", ""], feelings: ["nostalgia", "nostalgia"] }));
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.item.tags, ["parque"]);
  assert.deepEqual(valid.body.item.feelings, ["nostalgia"]);
  for (const value of ["", "0", "-1", "1.0", "1e1", "9007199254740992"]) {
    assert.equal((await f.call("DELETE", "/leap?version=" + value)).status, 400);
  }
});

test("list pagination is bounded and stable across equal creation timestamps", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 205; index++) f.seed("entry-" + String(index).padStart(3, "0"), entry(), { at: Math.floor(index / 3) });
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const response = await f.call("GET", cursor ? "?cursor=" + cursor : "");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, page === 2 ? 5 : 100);
    seen.push(...response.body.items.map(item => item.id));
    cursor = response.body.nextCursor;
    assert.equal(Boolean(cursor), page < 2);
  }
  assert.equal(new Set(seen).size, 205);
  assert.deepEqual(seen, [...seen].sort().reverse());
  const invalid = ["", "%%", Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ at: -1, id: "memo" })).toString("base64url"),
    Buffer.from(JSON.stringify({ at: 1, id: "../other" })).toString("base64url"), "a".repeat(513)];
  for (const raw of invalid) assert.equal((await f.call("GET", "?cursor=" + encodeURIComponent(raw))).status, 400);
  assert.equal((await f.call("GET", "?cursor=a&cursor=b")).status, 400);
});

test("unavailable secrets and storage fail closed with private noncacheable responses", async t => {
  const f = await fixture(t, { secret: "" });
  const write = await f.call("PUT", "/memo", entry());
  assert.equal(write.status, 503);
  assert.equal(f.db.data.size, 0);
  assert.match(write.headers.get("cache-control"), /private, no-store/);
  f.setUnavailable(true);
  assert.equal((await f.call()).status, 503);
  f.setUnavailable(false);
  f.db.failWith(new Error("private user text must not reach responses"));
  const failure = await f.call();
  assert.equal(failure.status, 503);
  assert.equal(JSON.stringify(failure.body).includes("private user text"), false);
});

test("full account cleanup deletes every diary batch while preserving other accounts", async () => {
  const db = database();
  for (let index = 0; index < 805; index++) db.data.set(diary.entriesFor(db, "owner").doc("entry-" + index).path, {});
  db.data.set(diary.entriesFor(db, "other").doc("keep").path, {});
  assert.equal(await diary.deleteForAccount(db, "owner"), 805);
  assert.equal(db.data.size, 1);
  assert.equal(await diary.deleteForAccount(db, "owner"), 0);
  assert.ok(db.data.has(diary.entriesFor(db, "other").doc("keep").path));
});

test("account deletion purges personal entries before removing authentication and remains retryable on cleanup failure", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  for (const [file, route] of [
    ["admin.js", "/admin/delete-user"],
    ["therapy.js", "/therapy/admin/profissionais/:uid/excluir-definitivo"],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "../routes", file), "utf8");
    const start = source.indexOf('router.post("' + route + '"');
    assert.ok(start > 0);
    const body = source.slice(start, source.indexOf("\n}));", start) + 5);
    for (const fails of [false, true]) {
      const calls = [];
      let handler;
      const db = { collection: () => ({
        doc: () => ({ async get() { return { exists: false }; } }),
        where() { return this; }, limit() { return this; },
        async get() { return { empty: true, docs: [] }; },
      }) };
      const context = {
        router: { post(_route, ...handlers) { handler = handlers.at(-1); } },
        asyncHandler: fn => fn, adminLimiter: () => {}, requireAdmin: () => {},
        ensureDb: () => true, getDb: () => db,
        verifyAdminTherapy: async () => ({ uid: "administrator" }),
        admin: { auth: () => ({
          async getUserByEmail() { return { uid: "owner" }; },
          async deleteUser(uid) { calls.push("auth:" + uid); },
        }) },
        async deleteDiaryForAccount(receivedDb, uid) {
          assert.equal(receivedDb, db);
          assert.equal(uid, "owner");
          calls.push("diary");
          if (fails) throw new Error("private storage failure");
          return 17;
        },
        sendError: (res, status, error) => res.status(status).json({ ok: false, error }),
        logInfo: () => {}, logWarn: () => {}, logAudit: async () => {},
      };
      vm.runInNewContext(body, context);
      const res = { statusCode: 200, status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; } };
      await handler({ params: { uid: "owner" }, body: { email: "owner@example.test", confirmUid: "owner" } }, res);
      assert.deepEqual(calls, fails ? ["diary"] : ["diary", "auth:owner"]);
      assert.equal(res.statusCode, fails ? 503 : 200);
      if (fails) assert.equal(res.body.error, "DIARIO_EXCLUSAO_FALHOU");
    }
  }
});
