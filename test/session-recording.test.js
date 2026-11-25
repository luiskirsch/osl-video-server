"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const firestore = require("../services/firestore");
const sessionRecording = require("../services/sessionRecording");
const { runSessionRecordingCleanup } = require("../jobs/sessionRecordingCleanup");

const DAY = 24 * 60 * 60 * 1000;

// Firestore mínimo: coleção → Map(docId → dados), com where/limit/get/batch.
function fakeDb(seed = {}) {
  const collections = new Map();
  for (const [path, data] of Object.entries(seed)) {
    const [name, id] = path.split("/");
    if (!collections.has(name)) collections.set(name, new Map());
    collections.get(name).set(id, { ...data });
  }
  const col = name => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
  const ref = (name, id) => ({
    id,
    async set(data, opts) { col(name).set(id, opts?.merge ? { ...(col(name).get(id) || {}), ...data } : { ...data }); },
    async delete() { col(name).delete(id); },
  });
  const query = (name, filters = [], max = Infinity) => ({
    where(field, op, value) { return query(name, [...filters, { field, op, value }], max); },
    limit(n) { return query(name, filters, n); },
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(({ field, op, value }) => (op === "==" ? d[field] === value : d[field] < value)))
        .slice(0, max)
        .map(([id, d]) => ({ id, ref: ref(name, id), data: () => ({ ...d }) }));
      return { empty: docs.length === 0, docs };
    },
  });
  return {
    collections,
    collection(name) { return { doc: id => ref(name, id), ...query(name) }; },
    batch() { const ops = []; return { delete: r => ops.push(r), async commit() { for (const r of ops) await r.delete(); } }; },
  };
}

test("retention: unpurchased ~1h after the match, declined in minutes, purchased 7 days", async t => {
  const db = fakeDb();
  t.mock.method(firestore, "getDb", () => db);
  const doc = id => db.collections.get("session_recordings").get(id);
  const startedAt = Date.UTC(2026, 10, 17, 12);
  const HOUR = 60 * 60 * 1000;

  await sessionRecording.recordStarted("CDDSF", { egressId: "EG_1", filepath: "recordings/CDDSF/1-pendente.mp4", type: "pendente", startedAt });
  assert.equal(doc("EG_1").status, "recording");
  assert.equal(doc("EG_1").expiresAtMs - startedAt, 7 * DAY, "teto enquanto grava");

  const stop = startedAt + 2 * HOUR;
  await sessionRecording.recordStopped({ egressId: "EG_1", type: "pendente" }, { now: stop });
  assert.equal(doc("EG_1").expiresAtMs - stop, HOUR, "ninguém comprou: ~1h após o fim");

  await sessionRecording.recordStarted("R2", { egressId: "EG_2", filepath: "recordings/R2/2.mp4", type: "pendente", startedAt });
  await sessionRecording.recordStopped({ egressId: "EG_2", type: "pendente", declined: true }, { now: stop });
  assert.equal(doc("EG_2").expiresAtMs - stop, 10 * 60 * 1000, "anfitrião recusou: minutos");

  await sessionRecording.recordStarted("R3", { egressId: "EG_3", filepath: "recordings/R3/3.mp4", type: "pendente", startedAt });
  await sessionRecording.recordStopped({ egressId: "EG_3", type: "gravacao-download" }, { now: stop });
  assert.equal(doc("EG_3").expiresAtMs - stop, 7 * DAY, "comprou: 7 dias");
});

test("a purchase confirmed after the match attaches to the recent recording (idempotent)", async t => {
  const now = Date.UTC(2026, 10, 17, 15);
  const db = fakeDb({
    "session_recordings/EG_OLD": { roomId: "SALA1", egressId: "EG_OLD", filepath: "recordings/SALA1/old.mp4", type: "pendente", status: "stopped", startedAtMs: now - 5 * DAY, expiresAtMs: now - 1 },
    "session_recordings/EG_NEW": { roomId: "SALA1", egressId: "EG_NEW", filepath: "recordings/SALA1/new.mp4", type: "pendente", status: "stopped", startedAtMs: now - 3600000, expiresAtMs: now + 1800000 },
  });
  t.mock.method(firestore, "getDb", () => db);

  const first = await sessionRecording.attachPurchase("SALA1", { ref: "PAG-1", now });
  assert.equal(first.filepath, "recordings/SALA1/new.mp4");
  const stored = db.collections.get("session_recordings").get("EG_NEW");
  assert.equal(stored.type, "gravacao-download");
  assert.equal(stored.expiresAtMs - now, 7 * DAY);

  const again = await sessionRecording.attachPurchase("SALA1", { ref: "PAG-1", now: now + 1000 });
  assert.equal(again.egressId, "EG_NEW", "mesma compra devolve o mesmo arquivo");
  assert.equal(await sessionRecording.attachPurchase("SALA1", { ref: "PAG-2", now }), null, "outra compra não pega arquivo já comprado nem vencido");
});

test("declining after the match shortens the grace to minutes; a purchased file is untouched", async t => {
  const now = Date.UTC(2026, 10, 17, 15);
  const db = fakeDb({
    "session_recordings/EG_A": { roomId: "SALA2", egressId: "EG_A", filepath: "recordings/SALA2/a.mp4", type: "pendente", status: "stopped", startedAtMs: now - 3600000, expiresAtMs: now + 3000000 },
    "session_recordings/EG_B": { roomId: "SALA3", egressId: "EG_B", filepath: "recordings/SALA3/b.mp4", type: "gravacao-download", status: "stopped", startedAtMs: now - 3600000, expiresAtMs: now + 6 * DAY },
  });
  t.mock.method(firestore, "getDb", () => db);
  await sessionRecording.expireLatestUnpurchased("SALA2", { now });
  assert.equal(db.collections.get("session_recordings").get("EG_A").expiresAtMs - now, 10 * 60 * 1000);
  assert.equal(await sessionRecording.expireLatestUnpurchased("SALA3", { now }), null);
  assert.equal(db.collections.get("session_recordings").get("EG_B").expiresAtMs - now, 6 * DAY);
});

test("discard targets the selected match when a room hosts consecutive matches", async t => {
  const now = Date.now();
  const pending = { roomId: "SALA", status: "stopped", expiresAtMs: now + 3600000 };
  const db = fakeDb({
    "session_recordings/A": { ...pending, sessionId: "first", startedAtMs: now - 2000 },
    "session_recordings/B": { ...pending, sessionId: "second", startedAtMs: now - 1000 },
  });
  t.mock.method(firestore, "getDb", () => db);
  assert.equal(await sessionRecording.expireLatestUnpurchased("SALA", { now, sessionId: "missing" }), null);
  await sessionRecording.expireLatestUnpurchased("SALA", { now, sessionId: "first" });
  const recordings = db.collections.get("session_recordings");
  assert.equal(recordings.get("A").expiresAtMs, now + sessionRecording.DECLINED_GRACE_MS);
  assert.equal(recordings.get("B").expiresAtMs, pending.expiresAtMs);
});

test("missing recording infrastructure never breaks the session", async () => {
  // Sem S3_* no ambiente de teste: a política registra o problema e segue.
  assert.equal(sessionRecording.storageConfigured(), false);
  assert.equal(await sessionRecording.ensureSessionRecording("ROOM1", "test"), null);
});

test("after a restart, recordings still running are re-adopted and the rest marked interrupted", async t => {
  const now = Date.now();
  const db = fakeDb({
    "session_recordings/EG_LIVE": { roomId: "AAAAA", egressId: "EG_LIVE", filepath: "recordings/AAAAA/x.mp4", status: "recording", startedAtMs: now - 1000 },
    "session_recordings/EG_GONE": { roomId: "BBBBB", egressId: "EG_GONE", filepath: "recordings/BBBBB/y.mp4", status: "recording", startedAtMs: now - 5000 },
    "session_recordings/EG_DONE": { roomId: "CCCCC", egressId: "EG_DONE", filepath: "recordings/CCCCC/z.mp4", status: "stopped", startedAtMs: now - 9000 },
  });
  t.mock.method(firestore, "getDb", () => db);
  const activeRecordings = new Map();
  const egressClient = { listEgress: async () => [{ egressId: "EG_LIVE" }] };

  const result = await sessionRecording.rehydrate({ egressClient, activeRecordings, now });
  assert.deepEqual(result, { restored: 1, finished: 1 });
  assert.equal(activeRecordings.get("AAAAA").egressId, "EG_LIVE");
  assert.equal(activeRecordings.has("BBBBB"), false);
  assert.equal(db.collections.get("session_recordings").get("EG_GONE").status, "interrupted");
  assert.equal(db.collections.get("session_recordings").get("EG_GONE").expiresAtMs - now, 60 * 60 * 1000, "interrompida sem compra: prazo de 1h");
  assert.equal(db.collections.get("session_recordings").get("EG_DONE").status, "stopped");
});

test("cleanup deletes due recordings (video + manifest) and old orphans, never one still recording", async () => {
  const now = Date.UTC(2026, 11, 20);
  const db = fakeDb({
    "session_recordings/EG_DUE": { roomId: "A", egressId: "EG_DUE", filepath: "recordings/A/due.mp4", status: "stopped", expiresAtMs: now - 1 },
    "session_recordings/EG_REC": { roomId: "B", egressId: "EG_REC", filepath: "recordings/B/rec.mp4", status: "recording", expiresAtMs: now - 1 },
    "session_recordings/EG_PAID": { roomId: "C", egressId: "EG_PAID", filepath: "recordings/C/paid.mp4", status: "stopped", type: "gravacao-download", expiresAtMs: now + DAY },
  });
  const objects = new Map([
    ["recordings/A/due.mp4", now - 2 * 3600000],
    ["recordings/A/EG_DUE.json", now - 2 * 3600000],
    ["recordings/B/rec.mp4", now - 3600000],
    ["recordings/C/paid.mp4", now - 6 * DAY],
    ["recordings/D/orphan.mp4", now - 8 * DAY],
    ["backups/firestore/2026-01-01.ndjson.gz.enc", now - 300 * DAY],
  ]);
  const s3 = {
    async send(command) {
      const name = command.constructor.name, input = command.input;
      if (name === "DeleteObjectsCommand") { for (const { Key } of input.Delete.Objects) objects.delete(Key); return {}; }
      if (name === "ListObjectsV2Command") {
        return { Contents: [...objects].filter(([k]) => k.startsWith(input.Prefix)).map(([Key, ms]) => ({ Key, LastModified: new Date(ms) })) };
      }
      throw new Error("comando inesperado " + name);
    },
  };

  const result = await runSessionRecordingCleanup({ db, s3, bucket: "osl-recordings", now });
  assert.deepEqual([...objects.keys()].sort(), ["backups/firestore/2026-01-01.ndjson.gz.enc", "recordings/B/rec.mp4", "recordings/C/paid.mp4"]);
  assert.deepEqual([...db.collections.get("session_recordings").keys()].sort(), ["EG_PAID", "EG_REC"]);
  assert.deepEqual(result, { registros: 1, arquivos: 3 });
});

test("backup can live under a prefix of a shared bucket; callers see unprefixed keys", async t => {
  const backup = require("../services/backup");
  const { S3Client } = require("@aws-sdk/client-s3");
  const seen = [];
  t.mock.method(S3Client.prototype, "send", async command => {
    seen.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "ListObjectsV2Command") {
      return { Contents: [{ Key: "backups/firestore/2026-11-17.ndjson.gz.enc" }] };
    }
    return {};
  });
  const r2 = backup.createR2({ endpoint: "https://r2.example", bucket: "osl-recordings", accessKeyId: "i", secretAccessKey: "s", prefix: "backups/" });
  await r2.put("firestore/2026-11-17.ndjson.gz.enc", Buffer.from("x"));
  assert.deepEqual(await r2.list("firestore/"), ["firestore/2026-11-17.ndjson.gz.enc"]);
  await r2.remove(["firestore/2026-11-17.ndjson.gz.enc"]);
  assert.equal(seen[0].input.Key, "backups/firestore/2026-11-17.ndjson.gz.enc");
  assert.equal(seen[1].input.Prefix, "backups/firestore/");
  assert.equal(seen[2].input.Delete.Objects[0].Key, "backups/firestore/2026-11-17.ndjson.gz.enc");

  const base = { BACKUP_R2_ENDPOINT: "e", BACKUP_R2_BUCKET: "b", BACKUP_R2_ACCESS_KEY_ID: "i", BACKUP_R2_SECRET_ACCESS_KEY: "s", BACKUP_ENCRYPTION_KEY: "k" };
  assert.equal(backup.backupConfig(base).prefix, "", "EP continua na raiz do próprio bucket");
  assert.equal(backup.backupConfig({ ...base, BACKUP_R2_PREFIX: "backups" }).prefix, "backups/");
  assert.throws(() => backup.backupConfig({ ...base, BACKUP_R2_PREFIX: "../fora" }), /PREFIX_INVALIDO/);
});

test("recording follows the game session only: the lobby video does not keep it running", async t => {
  const state = require("../game/state");
  const webrtc = require("../video/webrtc");
  const stops = [];
  t.mock.method(webrtc, "stopRoomRecording", async roomId => { stops.push(roomId); return { egressStopOk: true }; });
  state.activeRecordings.set("SESS1", { egressId: "EG_S1" });
  state.panelRooms.set("SESS1", { sessionActive: true, videoActive: true });
  t.after(() => { state.activeRecordings.delete("SESS1"); state.panelRooms.delete("SESS1"); });

  assert.equal(await sessionRecording.endSessionRecording("SESS1"), null, "sessão ainda ativa: não para");
  assert.deepEqual(stops, []);

  state.panelRooms.get("SESS1").sessionActive = false; // fim da partida; vídeo do lobby segue ligado
  await sessionRecording.endSessionRecording("SESS1");
  assert.deepEqual(stops, ["SESS1"]);

});
