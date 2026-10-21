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

// Firestore mínimo a partir de { "col/doc": data, "col/doc/sub/x": data }. Como
// no real, um pai pode não existir ("documento ausente") e ter subcoleções.
function fakeDb(docs) {
  const paths = Object.keys(docs);
  function docRef(p) { return { path: p, listCollections: async () => collectionsUnder(p) }; }
  function collection(collPath) {
    const depth = collPath.split("/").length + 1;
    return {
      async listDocuments() {
        const ids = new Set(paths.filter(p => p.startsWith(collPath + "/")).map(p => p.split("/").slice(0, depth).join("/")));
        return [...ids].sort().map(docRef);
      }
    };
  }
  function collectionsUnder(prefix) {
    const depth = prefix ? prefix.split("/").length + 1 : 1;
    const names = new Set(paths.filter(p => (!prefix || p.startsWith(prefix + "/")) && p.split("/").length > depth)
      .map(p => p.split("/").slice(0, depth).join("/")));
    return [...names].sort().map(collection);
  }
  return {
    listCollections: async () => collectionsUnder(""),
    getAll: async (...refs) => refs.map(ref => ({ ref, exists: ref.path in docs, data: () => docs[ref.path] })),
    doc: p => ({ path: p })
  };
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

test("export alcança documentos sob pais inexistentes (subcoleções órfãs)", async () => {
  const docs = { "salas/viva": { n: 1 }, "salas/apagada/ritual/r1": { t: 1 }, "salas/apagada/ritual/r1/history/h1": { t: 2 },
    "therapy_patients/p/notes/n1": { t: 3 } };
  const dump = await backup.exportFirestore(fakeDb(docs));
  assert.deepEqual(dump.ndjson.trim().split("\n").map(l => JSON.parse(l).path).sort(), Object.keys(docs).sort());
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

test("retenção mantém diários por 1 ano e o dia 1º por 5 anos; arquivo/ nunca expira", () => {
  const now = new Date("2026-10-17T06:00:00Z");
  const keys = ["firestore/2026-10-16.ndjson.gz.enc", "firestore/2026-01-10.ndjson.gz.enc",
    "firestore/2025-09-10.ndjson.gz.enc", "firestore/2022-08-01.ndjson.gz.enc", "firestore/2021-08-01.ndjson.gz.enc",
    "storage/manifest.json.gz.enc", "arquivo/2026-10-17-pre-migracao-jogo.ndjson.gz.enc"];
  assert.deepEqual(backup.expiredDumps(keys, now), ["firestore/2025-09-10.ndjson.gz.enc", "firestore/2021-08-01.ndjson.gz.enc"]);
});

test("backupConfig exige todas as variáveis", () => {
  assert.equal(backup.backupConfig({ BACKUP_R2_BUCKET: "b" }), null);
  assert.ok(backup.backupConfig({ BACKUP_R2_ENDPOINT: "e", BACKUP_R2_BUCKET: "b", BACKUP_R2_ACCESS_KEY_ID: "i",
    BACKUP_R2_SECRET_ACCESS_KEY: "s", BACKUP_ENCRYPTION_KEY: key.toString("base64") }));
});

function tickFixture(docs = { "therapists/a": { name: "synthetic" } }) {
  const db = fakeDb(docs), locks = new Map(), r2 = memoryR2();
  db.collection = name => {
    assert.equal(name, "ops_backups");
    return { doc: date => ({
      async get() { return { exists: locks.has(date), data: () => ({ ...locks.get(date) }) }; },
      async create(value) { if (locks.has(date)) throw new Error("ALREADY_EXISTS"); locks.set(date, { ...value }); },
      async update(value) { locks.set(date, { ...locks.get(date), ...value }); }
    }) };
  };
  return { db, locks, r2, run: (now, extra = {}) => backup.tick({ db, getBucket: () => null,
    config: { encryptionKey: key.toString("base64") }, r2Factory: () => r2, now: new Date(now), ...extra }) };
}

test("backup esgotado por cota não repete a varredura na próxima tentativa do dia", async () => {
  const f = tickFixture(); let scans = 0;
  f.db.listCollections = async () => { scans++; throw Object.assign(new Error("RESOURCE_EXHAUSTED: Quota exceeded."), { code: 8 }); };
  await assert.rejects(f.run("2026-10-21T05:00:00Z"), /Quota exceeded/);
  assert.equal(f.locks.get("2026-10-21").status, "quota_exhausted");
  assert.deepEqual(await f.run("2026-10-21T06:00:00Z"), { skipped: "cota_esgotada" });
  assert.equal(scans, 1);
});

test("backup não recomeça após consumir o orçamento, inclusive com locks da versão anterior", async () => {
  const f = tickFixture(); let scans = 0;
  const list = f.db.listCollections;
  f.db.listCollections = async () => { scans++; return list(); };
  await assert.rejects(f.run("2026-10-21T05:00:00Z", { maxReads: 2 }), /ORCAMENTO/);
  assert.equal(f.locks.get("2026-10-21").status, "quota_exhausted");
  assert.deepEqual(await f.run("2026-10-21T06:00:00Z"), { skipped: "cota_esgotada" });
  assert.equal(scans, 1);
  f.locks.set("2026-10-22", { status: "failed", error: "BACKUP_ORCAMENTO_LEITURAS_EXCEDIDO", attempts: 1 });
  assert.deepEqual(await f.run("2026-10-22T05:00:00Z"), { skipped: "cota_esgotada" });
  assert.equal(scans, 1);
});

test("backup reserva leituras antes de buscar os documentos e não publica dump incompleto", async () => {
  const f = tickFixture(); let lookups = 0;
  const getAll = f.db.getAll;
  f.db.getAll = async (...refs) => { lookups++; return getAll(...refs); };
  await assert.rejects(f.run("2026-10-21T05:00:00Z", { maxReads: 2 }), /ORCAMENTO/);
  assert.equal(lookups, 0);
  assert.equal(f.r2.objects.size, 0);
});

test("falha no armazenamento externo mantém o consumo no orçamento das próximas tentativas", async () => {
  const f = tickFixture();
  f.r2.put = async () => { throw new Error("R2_UNAVAILABLE"); };
  await assert.rejects(f.run("2026-10-21T05:00:00Z", { maxReads: 6 }), /R2_UNAVAILABLE/);
  const used = f.locks.get("2026-10-21").readsUsed;
  assert.ok(used > 0 && used <= 6);
  await assert.rejects(f.run("2026-10-21T06:00:00Z", { maxReads: 6 }), /ORCAMENTO/);
  assert.ok(f.locks.get("2026-10-21").readsUsed <= 6);
  assert.equal(f.locks.get("2026-10-21").status, "quota_exhausted");
});

test("backup não inicia fora da janela nem consome a franquia renovada após 07 UTC", async () => {
  const f = tickFixture();
  for (const hour of ["00:00", "04:59", "07:00", "08:00", "15:00", "23:59"]) {
    assert.deepEqual(await f.run("2026-10-21T" + hour + ":00Z"), { skipped: "fora_da_janela" });
  }
  assert.equal(f.locks.size, 0);
});

test("um novo dia permite backup completo e preserva a verificação de integridade", async () => {
  const f = tickFixture();
  f.locks.set("2026-10-21", { status: "quota_exhausted", attempts: 1 });
  const result = await f.run("2026-10-22T05:00:00Z");
  assert.equal(result.documents, 1);
  assert.equal(f.locks.get("2026-10-22").status, "done");
  assert.equal(f.locks.get("2026-10-22").readsUsed, result.reads);
  assert.deepEqual(await f.run("2026-10-22T06:00:00Z"), { skipped: "ja_executado" });
});
