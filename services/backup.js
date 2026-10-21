"use strict";
// Backup diário cifrado do Firestore + Firebase Storage para um bucket R2
// privado (fora do Google). Não depende de faturamento no GCP.
//
// Layout no bucket:
//   firestore/YYYY-MM-DD.ndjson.gz.enc   dump completo do dia (1 doc por linha)
//   storage/objects/<sha256(nome)>-<md5>.enc   cada arquivo, incremental
//   storage/manifest.json.gz.enc         nome → objeto cifrado + metadados
//   arquivo/…                            retratos permanentes (nunca rotacionados)
//
// Retenção: diários por 1 ano; o do dia 1º de cada mês por 5 anos (guarda do
// prontuário, Resolução CFP 001/2009).
//
// Formato cifrado: "EPBK1" | iv(12) | ciphertext | tag(16), AES-256-GCM.
// O AAD é a chave do objeto no bucket: trocar arquivos de lugar quebra a
// autenticação. A chave mestra (BACKUP_ENCRYPTION_KEY) tem cópia offline.
//
// Orçamento: o projeto está no plano gratuito do Firebase (50k leituras/dia,
// 1 GB/dia de download do Storage). Estourar a cota derruba o app até o reset,
// então o orçamento vale para todas as tentativas do dia. O job só inicia
// antes do reset diário (~07-08 UTC); cota/orçamento esgotado não é repetido.
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Timestamp, GeoPoint, DocumentReference } = require("firebase-admin/firestore");
const { logInfo, logError } = require("../logger");

const MAGIC = Buffer.from("EPBK1");
const DAILY_RETENTION_DAYS = 366;
const MONTHLY_RETENTION_DAYS = 5 * 366;
const DEFAULT_MAX_READS = 30_000;
const DEFAULT_MAX_STORAGE_BYTES = 700 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const RUN_HOUR_UTC = 5;
const STOP_HOUR_UTC = 7;
const STALE_LOCK_MS = 3 * 60 * 60 * 1000;
const LOCKS = "ops_backups";

function parseKey(raw) {
  const key = Buffer.from(String(raw || ""), "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY_INVALIDA");
  return key;
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

function decrypt(key, blob, aad) {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("BACKUP_FORMATO_INVALIDO");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(-16));
  return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + 12, -16)), decipher.final()]);
}

// ─── Serialização com tipos do Firestore ────────────────────────────────
// Objetos com chaves começando em "$" são embrulhados em {$obj} para não
// colidir com as marcações de tipo.
function encodeValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Timestamp) return { $ts: [value.seconds, value.nanoseconds] };
  if (value instanceof GeoPoint) return { $geo: [value.latitude, value.longitude] };
  if (value instanceof DocumentReference) return { $ref: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encodeValue);
  const out = {};
  let tagged = false;
  for (const [k, v] of Object.entries(value)) { out[k] = encodeValue(v); if (k.startsWith("$")) tagged = true; }
  return tagged ? { $obj: out } : out;
}

function decodeValue(value, db) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => decodeValue(v, db));
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [k] = keys, v = value[k];
    if (k === "$ts") return new Timestamp(v[0], v[1]);
    if (k === "$geo") return new GeoPoint(v[0], v[1]);
    if (k === "$ref") return db ? db.doc(v) : { $ref: v };
    if (k === "$bytes") return Buffer.from(v, "base64");
    if (k === "$obj") value = v;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v, db);
  return out;
}

// ─── Firestore ──────────────────────────────────────────────────────────
async function exportFirestore(db, { maxReads = DEFAULT_MAX_READS } = {}) {
  const lines = [];
  let reads = 0;
  const spend = (n, alreadyRead = false) => {
    if (reads + n > maxReads) {
      if (alreadyRead) reads += n;
      throw Object.assign(new Error("BACKUP_ORCAMENTO_LEITURAS_EXCEDIDO"), { reads });
    }
    reads += n;
  };
  // listDocuments() inclui "documentos ausentes": pais apagados cujas
  // subcoleções continuam com dados. Uma consulta comum não os alcança, e o
  // que está embaixo deles ficaria fora do backup.
  async function walkCollection(collection) {
    const refs = await collection.listDocuments();
    spend(Math.max(1, refs.length), true);
    for (let i = 0; i < refs.length; i += 100) {
      const chunk = refs.slice(i, i + 100);
      spend(chunk.length);
      const snaps = await db.getAll(...chunk);
      for (const snap of snaps) {
        if (snap.exists) lines.push(JSON.stringify({ path: snap.ref.path, data: encodeValue(snap.data()) }));
      }
    }
    for (const ref of refs) {
      spend(1);
      const subs = await ref.listCollections();
      for (const sub of subs) await walkCollection(sub);
    }
  }
  spend(1);
  try {
    const roots = await db.listCollections();
    for (const collection of roots) await walkCollection(collection);
    return { ndjson: lines.join("\n") + (lines.length ? "\n" : ""), documents: lines.length, reads };
  } catch (error) {
    error.backupReads = reads;
    throw error;
  }
}

// ─── R2 (S3) ────────────────────────────────────────────────────────────
function createR2({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  return {
    async put(key, body) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/octet-stream" })); },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (error) {
        if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of res.Contents || []) keys.push(item.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })) } }));
      }
    }
  };
}

const MANIFEST_KEY = "storage/manifest.json.gz.enc";
function storageObjectKey(name, md5) {
  const md5hex = Buffer.from(String(md5 || ""), "base64").toString("hex") || "nomd5";
  return `storage/objects/${crypto.createHash("sha256").update(name).digest("hex")}-${md5hex}.enc`;
}

async function loadManifest(r2, key) {
  const blob = await r2.get(MANIFEST_KEY);
  if (!blob) return { version: 1, files: {} };
  return JSON.parse(zlib.gunzipSync(decrypt(key, blob, MANIFEST_KEY)).toString("utf8"));
}
async function saveManifest(r2, key, manifest) {
  await r2.put(MANIFEST_KEY, encrypt(key, zlib.gzipSync(JSON.stringify(manifest)), MANIFEST_KEY));
}

async function backupStorage(bucket, r2, key, { maxBytes = DEFAULT_MAX_STORAGE_BYTES, now = new Date() } = {}) {
  const manifest = await loadManifest(r2, key);
  const seen = new Set();
  let copied = 0, bytes = 0, skippedLarge = 0, pending = 0;
  let pageToken;
  do {
    const [files, next] = await bucket.getFiles({ autoPaginate: false, maxResults: 1000, pageToken });
    pageToken = next?.pageToken;
    for (const file of files) {
      const { name } = file;
      const md5 = file.metadata?.md5Hash || "";
      const size = Number(file.metadata?.size || 0);
      seen.add(name);
      const current = manifest.files[name];
      if (current && current.md5 === md5 && !current.deletedAt) continue;
      if (size > MAX_FILE_BYTES) { skippedLarge++; continue; }
      if (bytes + size > maxBytes) { pending++; continue; }
      const [content] = await file.download();
      const objectKey = storageObjectKey(name, md5);
      await r2.put(objectKey, encrypt(key, content, objectKey));
      manifest.files[name] = { key: objectKey, md5, size, contentType: file.metadata?.contentType || "",
        backedUpAt: now.toISOString() };
      copied++; bytes += size;
    }
  } while (pageToken);
  // Arquivos apagados na origem continuam no backup (é justamente para isso).
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!seen.has(name) && !entry.deletedAt) entry.deletedAt = now.toISOString();
  }
  await saveManifest(r2, key, manifest);
  return { copied, bytes, pending, skippedLarge, total: Object.keys(manifest.files).length };
}

// ─── Retenção ───────────────────────────────────────────────────────────
// Diários por 1 ano + o do dia 1º de cada mês por 5 anos.
function expiredDumps(keys, now = new Date()) {
  return keys.filter(key => {
    const match = /^firestore\/(\d{4})-(\d{2})-(\d{2})\.ndjson\.gz\.enc$/.exec(key);
    if (!match) return false;
    const ageDays = (now - Date.UTC(+match[1], +match[2] - 1, +match[3])) / 86_400_000;
    if (ageDays <= DAILY_RETENTION_DAYS) return false;
    return !(match[3] === "01" && ageDays <= MONTHLY_RETENTION_DAYS);
  });
}

// ─── Execução ───────────────────────────────────────────────────────────
function backupConfig(env = process.env) {
  const config = {
    endpoint: env.BACKUP_R2_ENDPOINT, bucket: env.BACKUP_R2_BUCKET,
    accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY,
    encryptionKey: env.BACKUP_ENCRYPTION_KEY
  };
  return Object.values(config).every(Boolean) ? config : null;
}

async function runBackup({ db, bucket, r2, key, now = new Date(), maxReads, maxStorageBytes }) {
  const date = now.toISOString().slice(0, 10);
  const dump = await exportFirestore(db, { maxReads });
  try {
    const dumpKey = `firestore/${date}.ndjson.gz.enc`;
    const compressed = zlib.gzipSync(dump.ndjson);
    await r2.put(dumpKey, encrypt(key, compressed, dumpKey));
    // Verifica o que foi gravado: baixa, decifra e confere o hash.
    const stored = await r2.get(dumpKey);
    if (!stored || !crypto.timingSafeEqual(
      crypto.createHash("sha256").update(zlib.gunzipSync(decrypt(key, stored, dumpKey))).digest(),
      crypto.createHash("sha256").update(dump.ndjson).digest())) throw new Error("BACKUP_VERIFICACAO_FALHOU");
    // Falha no Storage não invalida o dump do Firestore, já gravado e verificado.
    let storage = null;
    try {
      if (bucket) storage = await backupStorage(bucket, r2, key, { maxBytes: maxStorageBytes, now });
    } catch (error) {
      // Plano Spark não tem bucket: os arquivos privados ficam no Firestore
      // (services/private-files.js) e já estão no dump acima.
      if (error?.code === 404) storage = { skipped: "SEM_BUCKET" };
      else {
        storage = { error: String(error.message || error).slice(0, 200) };
        logError("backup_storage_falhou", error);
      }
    }
    const expired = expiredDumps(await r2.list("firestore/"), now);
    if (expired.length) await r2.remove(expired);
    return { date, dumpKey, documents: dump.documents, reads: dump.reads, dumpBytes: compressed.length, storage, expired: expired.length };
  } catch (error) {
    error.backupReads = dump.reads;
    throw error;
  }
}

function quotaFailure(error) {
  return error?.code === 8 || /RESOURCE_EXHAUSTED|quota exceeded|BACKUP_ORCAMENTO_LEITURAS_EXCEDIDO/i.test(String(error?.message || error || ""));
}

// Lock idempotente por dia (create() é atômico: só uma réplica executa).
async function tick({ db, getBucket, config, now = new Date(), r2Factory = createR2, maxReads = DEFAULT_MAX_READS }) {
  // An hourly retry after the reset was consuming the new day's entire quota.
  // Never start a scan outside this window, including the first backup.
  if (now.getUTCHours() < RUN_HOUR_UTC || now.getUTCHours() >= STOP_HOUR_UTC) return { skipped: "fora_da_janela" };
  const date = now.toISOString().slice(0, 10);
  const lockRef = db.collection(LOCKS).doc(date);
  const existing = await lockRef.get();
  if (existing.exists) {
    const lock = existing.data();
    if (lock.status === "done") return { skipped: "ja_executado" };
    // Also recognize old failed locks written before this fix.
    if (lock.status === "quota_exhausted" || quotaFailure(lock.error)) return { skipped: "cota_esgotada" };
    if (lock.status === "running" && now - Number(lock.startedAtMs || 0) < STALE_LOCK_MS) return { skipped: "em_execucao" };
  }
  const readsUsed = Math.max(0, Number(existing.exists ? existing.data().readsUsed || 0 : 0));
  const remainingReads = Math.max(0, maxReads - readsUsed);
  if (!remainingReads) return { skipped: "cota_esgotada" };
  const attempt = Number(existing.exists ? existing.data().attempts || 0 : 0) + 1;
  if (attempt > 3) return { skipped: "tentativas_esgotadas" };
  const lock = { status: "running", startedAtMs: now.getTime(), attempts: attempt, readsUsed };
  try {
    if (existing.exists) await lockRef.update(lock); else await lockRef.create(lock);
  } catch (error) {
    return { skipped: "lock_concorrente" };
  }
  try {
    let bucket = null;
    try { bucket = getBucket(); } catch { /* sem Storage configurado: só Firestore */ }
    const result = await runBackup({ db, bucket, r2: r2Factory(config),
      key: parseKey(config.encryptionKey), now, maxReads: remainingReads });
    await lockRef.update({ status: "done", finishedAtMs: Date.now(), readsUsed: readsUsed + result.reads, result });
    logInfo("backup_concluido", result);
    return result;
  } catch (error) {
    await lockRef.update({ status: quotaFailure(error) ? "quota_exhausted" : "failed", finishedAtMs: Date.now(),
      readsUsed: readsUsed + Math.max(0, Number(error.backupReads || 0)), error: String(error.message || error).slice(0, 200) }).catch(() => {});
    logError("backup_falhou", error, { date, attempt });
    throw error;
  }
}

let timer = null;
function startBackupLoop({ getDb, getStorageBucket, appEnv }) {
  if (timer) return;
  const config = backupConfig();
  if (appEnv !== "production" || !config) {
    logInfo("backup_loop_desativado", { appEnv, configured: !!config });
    return;
  }
  const run = () => {
    const db = getDb();
    if (!db) return;
    tick({ db, getBucket: getStorageBucket, config }).catch(() => {});
  };
  const startup = setTimeout(run, 5 * 60 * 1000);
  startup.unref?.();
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  logInfo("backup_loop_iniciado", { bucket: config.bucket });
}
function stopBackupLoop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  parseKey, encrypt, decrypt, encodeValue, decodeValue, exportFirestore, backupStorage,
  storageObjectKey, loadManifest, expiredDumps, backupConfig, createR2, runBackup, tick,
  startBackupLoop, stopBackupLoop, MANIFEST_KEY
};
