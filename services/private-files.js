"use strict";
// Arquivos privados guardados no Firestore em pedaços (o projeto Firebase está
// no plano Spark, sem bucket de Storage). Usado pelos comprovantes de
// verificação de profissionais.
//
// Caminho lógico: "fs:<docId>". Os bytes ficam em
//   private_files/{docId}            { contentType, size, chunks, createdAt }
//   private_files/{docId}/chunks/{n} { i, data (base64) }

const admin = require("firebase-admin");

const COLLECTION = "private_files";
const CHUNK = 700_000; // bytes por pedaço — base64 fica bem abaixo de 1 MiB por documento
const PREFIX = "fs:";

const db = () => admin.firestore();
const isFirestorePath = path => typeof path === "string" && path.startsWith(PREFIX);
const docIdFrom = path => String(path).slice(PREFIX.length).replace(/[^\w.-]/g, "_").slice(0, 200);

async function savePrivateFile(key, buffer, { contentType = "application/octet-stream" } = {}) {
  const docId = String(key).replace(/[^\w.-]/g, "_").slice(0, 200);
  const ref = db().collection(COLLECTION).doc(docId);
  const chunks = Math.max(1, Math.ceil(buffer.length / CHUNK));
  for (let i = 0; i < chunks; i++) {
    await ref.collection("chunks").doc(String(i).padStart(3, "0")).set({
      i, data: buffer.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64")
    });
  }
  await ref.set({ contentType, size: buffer.length, chunks, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return PREFIX + docId;
}

async function readPrivateFile(path) {
  const ref = db().collection(COLLECTION).doc(docIdFrom(path));
  const snap = await ref.collection("chunks").orderBy("i").get();
  if (snap.empty) throw new Error("ARQUIVO_NAO_ENCONTRADO");
  return Buffer.concat(snap.docs.map(d => Buffer.from(d.data().data, "base64")));
}

async function deletePrivateFile(path) {
  const ref = db().collection(COLLECTION).doc(docIdFrom(path));
  const snap = await ref.collection("chunks").get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
  await ref.delete();
}

module.exports = { savePrivateFile, readPrivateFile, deletePrivateFile, isFirestorePath };
