"use strict";
// Arquivos privados guardados no Firestore em pedaços (o projeto Firebase está
// no plano Spark, sem bucket de Storage). Usado pelos comprovantes de
// verificação de profissionais.
//
// Caminho lógico: "fs:<docId>". Os bytes ficam em
//   private_files/{docId}            { contentType, size, chunks, createdAt }
//   private_files/{docId}/chunks/{n} { i, data (base64) }

const crypto = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const firestore = require("./firestore");

const COLLECTION = "private_files";
const CHUNK = 700_000; // bytes por pedaço — base64 fica bem abaixo de 1 MiB por documento
// Base64 plus metadata must also fit Firestore's 10 MiB commit limit.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_BYTES / CHUNK);
const PREFIX = "fs:";

function failure(code) { return Object.assign(new Error(code), { code }); }
function database() {
  const db = firestore.getDb();
  if (!db) throw failure("FIREBASE_ADMIN_NAO_CONFIGURADO");
  return db;
}
const isFirestorePath = path => typeof path === "string" && path.startsWith(PREFIX);
function docIdFrom(path) {
  if (typeof path !== "string" || !/^fs:[\w.-]{1,200}$/.test(path) || ["fs:.", "fs:.."].includes(path)) {
    throw failure("CAMINHO_ARQUIVO_INVALIDO");
  }
  return path.slice(PREFIX.length);
}
function digest(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

async function savePrivateFile(key, buffer, { contentType = "application/octet-stream" } = {}) {
  if (typeof key !== "string" || !key.length || key.length > 2048) throw failure("CHAVE_ARQUIVO_INVALIDA");
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw failure("TAMANHO_ARQUIVO_INVALIDO");
  if (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) || contentType.length > 127) {
    throw failure("TIPO_ARQUIVO_INVALIDO");
  }
  // Hash the complete key: sanitizing/truncating could alias unrelated files.
  const docId = digest(Buffer.from(key, "utf8"));
  const db = database();
  const ref = db.collection(COLLECTION).doc(docId);
  const chunks = Math.ceil(buffer.length / CHUNK);
  const batch = db.batch();
  for (let i = 0; i < chunks; i++) {
    batch.create(ref.collection("chunks").doc(String(i).padStart(3, "0")), {
      i, data: buffer.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64")
    });
  }
  batch.create(ref, { contentType, size: buffer.length, chunks, sha256: digest(buffer), createdAt: FieldValue.serverTimestamp() });
  // All chunks and metadata commit together; existing files cannot be overwritten.
  await batch.commit();
  return PREFIX + docId;
}

async function readPrivateFile(path) {
  const docId = docIdFrom(path);
  const ref = database().collection(COLLECTION).doc(docId);
  const metadata = await ref.get();
  if (!metadata.exists) throw failure("ARQUIVO_NAO_ENCONTRADO");
  const { size, chunks, sha256 } = metadata.data();
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES ||
      !Number.isSafeInteger(chunks) || chunks !== Math.ceil(size / CHUNK) ||
      (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)))) {
    throw failure("ARQUIVO_INTEGRO_INVALIDO");
  }
  const snap = await ref.collection("chunks").orderBy("i").limit(chunks + 1).get();
  if (snap.docs.length !== chunks) throw failure("ARQUIVO_INTEGRO_INVALIDO");
  const buffers = snap.docs.map((doc, index) => {
    const { i, data } = doc.data();
    const expectedSize = Math.min(CHUNK, size - index * CHUNK);
    if (i !== index || typeof data !== "string" || data.length !== 4 * Math.ceil(expectedSize / 3)) {
      throw failure("ARQUIVO_INTEGRO_INVALIDO");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length !== expectedSize || bytes.toString("base64") !== data) throw failure("ARQUIVO_INTEGRO_INVALIDO");
    return bytes;
  });
  const buffer = Buffer.concat(buffers, size);
  // Old records have no checksum; preserve their existing validated read path.
  if (sha256 !== undefined && digest(buffer) !== sha256) throw failure("ARQUIVO_INTEGRO_INVALIDO");
  return buffer;
}

async function deletePrivateFile(path) {
  const docId = docIdFrom(path);
  const db = database();
  const ref = db.collection(COLLECTION).doc(docId);
  const snap = await ref.collection("chunks").limit(MAX_CHUNKS + 1).get();
  if (snap.docs.length > MAX_CHUNKS) throw failure("ARQUIVO_INTEGRO_INVALIDO");
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  batch.delete(ref);
  await batch.commit();
}

module.exports = { savePrivateFile, readPrivateFile, deletePrivateFile, isFirestorePath };
