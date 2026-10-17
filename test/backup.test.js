"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Timestamp, GeoPoint } = require("firebase-admin/firestore");
const backup = require("../services/backup");

const key = crypto.randomBytes(32);

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    async put(k, body) { objects.set(k, Buffer.from(body)); },
    async get(k) { return objects.get(k) || null; },
    async list(prefix) { return [...objects.keys()].filter(k => k.startsWith(prefix)); },
    async remove(keys) { for (const k of keys) objects.delete(k); }
  };
}

// Firestore mínimo: coleções aninhadas a partir de { "col/doc": data }.
function fakeDb(docs) {
  const reads = { count: 0 };
  function collection(collPath) {
    const ids = Object.keys(docs).filter(p => p.startsWith(collPath + "/") && p.split("/").length === collPath.split("/").length + 1).sort();
    function query(start, limit) {
      return {
        orderBy: () => query(start, limit),
        limit: n => query(start, n),
        startAfter: cursor => query(ids.indexOf(cursor.ref.path) + 1, limit),
        async get() {
          const slice = ids.slice(start || 0, (start || 0) + (limit || ids.length));
          reads.count += slice.length;
          const docSnaps = slice.map(p => ({ ref: docRef(p), data: () => docs[p] }));
          return { size: docSnaps.length, docs: docSnaps };
        }
      };
    }
    return query(0, undefined);
  }
  function children(prefix) {
    const depth = prefix ? prefix.split("/").length + 1 : 1;
    const names = new Set(Object.keys(docs).filter(p => (!prefix || p.startsWith(prefix + "/")) && p.split("/").length > depth)
      .map(p => p.split("/").slice(0, depth).join("/")));
    if (!prefix) for (const p of Object.keys(docs)) names.add(p.split("/")[0]);
    return [...names].sort().map(collection);
  }
  function docRef(p) { return { path: p, listCollections: async () => children(p) }; }
  return { reads, listCollections: async () => children(""), doc: p => ({ path: p }) };
}

test("cifra com AAD: decifra o original e rejeita objeto trocado de lugar ou adulterado", () => {
  const blob = backup.encrypt(key, Buffer.from("prontuário"), "firestore/2026-10-17.ndjson.gz.enc");
  assert.equal(backup.decrypt(key, blob, "firestore/2026-10-17.ndjson.gz.enc").toString(), "prontuário");
  assert.throws(() => backup.decrypt(key, blob, "firestore/2026-10-16.ndjson.gz.enc"));
  const tampered = Buffer.from(blob); tampered[10] ^= 1;
  assert.throws(() => backup.decrypt(key, tampered, "firestore/2026-10-17.ndjson.gz.enc"));
  assert.throws(() => backup.parseKey("curta"), /BACKUP_ENCRYPTION_KEY_INVALIDA/);
});

test("serialização preserva tipos do Firestore e chaves que começam com $", () => {
  const original = { at: new Timestamp(1700000000, 123), geo: new GeoPoint(-23.5, -46.6),
    bin: Buffer.from([1, 2, 3]), nested: [{ $ts: "texto literal" }], n: 1, s: "x", nil: null };
  const decoded = backup.decodeValue(JSON.parse(JSON.stringify(backup.encodeValue(original))));
  assert.ok(decoded.at instanceof Timestamp && decoded.at.isEqual(original.at));
  assert.ok(decoded.geo instanceof GeoPoint && decoded.geo.isEqual(original.geo));
  assert.deepEqual([...decoded.bin], [1, 2, 3]);
  assert.deepEqual(decoded.nested, [{ $ts: "texto literal" }]);
  assert.equal(decoded.n, 1); assert.equal(decoded.nil, null);
});

test("export percorre subcoleções e aborta ao estourar o orçamento de leituras", async () => {
  const docs = { "therapists/a": { n: 1 }, "therapists/a/notes/x": { t: 1 }, "users/u": { n: 2 } };
  const dump = await backup.exportFirestore(fakeDb(docs));
  assert.deepEqual(dump.ndjson.trim().split("\n").map(l => JSON.parse(l).path).sort(), Object.keys(docs).sort());
  await assert.rejects(backup.exportFirestore(fakeDb(docs), { maxReads: 3 }), /ORCAMENTO/);
});

test("runBackup grava dump verificável, copia Storage incremental e marca apagados", async () => {
  const r2 = memoryR2();
  const files = [{ name: "docs/a.pdf", content: Buffer.from("A") }];
  const bucket = { async getFiles() {
    return [files.map(f => ({ name: f.name, metadata: { md5Hash: crypto.createHash("md5").update(f.content).digest("base64"),
      size: f.content.length, contentType: "application/pdf" }, download: async () => [f.content] })), null];
  } };
  const db = fakeDb({ "therapists/a": { nome: "A" } });
  const first = await backup.runBackup({ db, bucket, r2, key, now: new Date("2026-10-17T06:00:00Z") });
  assert.equal(first.documents, 1); assert.equal(first.storage.copied, 1);
  const dump = zlib.gunzipSync(backup.decrypt(key, r2.objects.get(first.dumpKey), first.dumpKey)).toString();
  assert.equal(JSON.parse(dump).path, "therapists/a");
  const again = await backup.runBackup({ db, bucket, r2, key, now: new Date("2026-10-18T06:00:00Z") });
  assert.equal(again.storage.copied, 0);
  files.length = 0;
  await backup.runBackup({ db, bucket, r2, key, now: new Date("2026-10-19T06:00:00Z") });
  const manifest = await backup.loadManifest(r2, key);
  assert.ok(manifest.files["docs/a.pdf"].deletedAt, "arquivo apagado continua no backup, marcado");
  assert.ok(r2.objects.has(manifest.files["docs/a.pdf"].key));
});

test("falha no Storage não invalida o dump do Firestore", async () => {
  const r2 = memoryR2();
  const result = await backup.runBackup({ db: fakeDb({ "a/1": {} }), r2, key,
    bucket: { getFiles: async () => { throw new Error("BUCKET_INEXISTENTE"); } } });
  assert.match(result.storage.error, /BUCKET_INEXISTENTE/);
  assert.ok(r2.objects.has(result.dumpKey));
  const spark = await backup.runBackup({ db: fakeDb({ "a/1": {} }), r2, key,
    bucket: { getFiles: async () => { throw Object.assign(new Error("The specified bucket does not exist."), { code: 404 }); } } });
  assert.deepEqual(spark.storage, { skipped: "SEM_BUCKET" });
});

test("retenção mantém 30 diários e o dia 1º por ~13 meses", () => {
  const now = new Date("2026-10-17T06:00:00Z");
  const keys = ["firestore/2026-10-16.ndjson.gz.enc", "firestore/2026-09-10.ndjson.gz.enc",
    "firestore/2026-08-01.ndjson.gz.enc", "firestore/2025-08-01.ndjson.gz.enc", "storage/manifest.json.gz.enc"];
  assert.deepEqual(backup.expiredDumps(keys, now), ["firestore/2026-09-10.ndjson.gz.enc", "firestore/2025-08-01.ndjson.gz.enc"]);
});

test("backupConfig exige todas as variáveis", () => {
  assert.equal(backup.backupConfig({ BACKUP_R2_BUCKET: "b" }), null);
  assert.ok(backup.backupConfig({ BACKUP_R2_ENDPOINT: "e", BACKUP_R2_BUCKET: "b", BACKUP_R2_ACCESS_KEY_ID: "i",
    BACKUP_R2_SECRET_ACCESS_KEY: "s", BACKUP_ENCRYPTION_KEY: key.toString("base64") }));
});
