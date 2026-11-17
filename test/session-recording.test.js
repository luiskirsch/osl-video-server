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

test("each recording is registered with a 30-day expiry", async t => {
  const db = fakeDb();
  t.mock.method(firestore, "getDb", () => db);
  const startedAt = Date.UTC(2026, 10, 17, 12);
  await sessionRecording.recordStarted("CDDSF", { egressId: "EG_1", filepath: "recordings/CDDSF/1-seguranca.mp4", type: "seguranca", startedAt });
  const doc = db.collections.get("session_recordings").get("EG_1");
  assert.equal(doc.roomId, "CDDSF");
  assert.equal(doc.status, "recording");
  assert.equal(doc.expiresAtMs - startedAt, 30 * DAY);

  await sessionRecording.recordStopped({ egressId: "EG_1", type: "gravacao-download" });
  const stopped = db.collections.get("session_recordings").get("EG_1");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.type, "gravacao-download");
  assert.equal(stopped.expiresAtMs - startedAt, 30 * DAY, "parar não estende o prazo");
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
  assert.equal(db.collections.get("session_recordings").get("EG_DONE").status, "stopped");
});

test("cleanup deletes expired recordings and orphan files older than 30 days, nothing else", async () => {
  const now = Date.UTC(2026, 11, 20);
  const db = fakeDb({
    "session_recordings/OLD": { roomId: "A", filepath: "recordings/A/old.mp4", expiresAtMs: now - 1 },
    "session_recordings/NEW": { roomId: "B", filepath: "recordings/B/new.mp4", expiresAtMs: now + DAY },
  });
  const objects = new Map([
    ["recordings/A/old.mp4", now - 31 * DAY],
    ["recordings/B/new.mp4", now - 2 * DAY],
    ["recordings/C/orphan.mp4", now - 40 * DAY],
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
  assert.deepEqual([...objects.keys()].sort(), ["backups/firestore/2026-01-01.ndjson.gz.enc", "recordings/B/new.mp4"]);
  assert.deepEqual([...db.collections.get("session_recordings").keys()], ["NEW"]);
  assert.deepEqual(result, { registros: 1, arquivos: 2 });
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

  assert.equal(await sessionRecording.ensureSessionRecordingIfActive("SESS1", "test"), null, "sem sessão, não reabre");
});
