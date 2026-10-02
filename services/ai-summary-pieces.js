"use strict";

// Transcrição progressiva do resumo IA.
//
// Durante a consulta o navegador do profissional manda pedaços de ~90 s de
// áudio (cada um é um WebM completo). Cada pedaço é transcrito na hora e só o
// TEXTO fica guardado, cifrado com a chave de resultado da sessão (derivada da
// DEK do profissional no navegador; o servidor só a recebe por requisição).
// Ao encerrar, os textos são decifrados, juntados em ordem e resumidos; os
// pedaços são apagados. O áudio nunca é persistido no servidor.
//
// Coleção própria (therapy_ai_pieces) com campos simples: consultas por
// sessionId e varredura por createdAt usam só índices de campo único.

const { encryptJson, decryptJson } = require("./clinical-encryption");

const PIECES_COLLECTION = "therapy_ai_pieces";
// Chave do pedaço: início (ms) + sufixo aleatório. Ex.: "1790980000000-a1b2c3".
const PIECE_KEY_RE = /^\d{10,16}(?:-[a-z0-9]{1,16})?$/;
const PIECE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isValidPieceKey(key) {
  return typeof key === "string" && PIECE_KEY_RE.test(key);
}

function pieceOrder(key) {
  return Number(String(key).split("-")[0]) || 0;
}

function pieceRef(db, sessionId, key) {
  return db.collection(PIECES_COLLECTION).doc(`${sessionId}__${key}`);
}

async function hasPiece(db, sessionId, key) {
  return (await pieceRef(db, sessionId, key).get()).exists;
}

// Há texto parcial guardado para a sessão? (o prontuário oferece "Tentar de
// novo" mesmo sem áudio no computador do profissional).
async function hasAnyPiece(db, sessionId) {
  const snap = await db.collection(PIECES_COLLECTION).where("sessionId", "==", sessionId).limit(1).get();
  return snap.size > 0;
}

// Grava o texto de um pedaço (idempotente pela chave). `result` vem do
// whisper.transcribe; `failed` marca pedaço ilegível — conta como presente
// para o navegador não reenviar para sempre, mas não contribui com texto.
async function storePiece({ db, admin, sessionId, therapistUid, key, result, failed = false, clientKey }) {
  const text = failed || result?.hallucinated ? "" : String(result?.text || "");
  const encrypted = encryptJson({ text }, clientKey);
  await pieceRef(db, sessionId, key).set({
    sessionId,
    therapistUid,
    key,
    order: pieceOrder(key),
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    durationSec: Number(result?.durationSec) || 0,
    hallucinated: !!result?.hallucinated,
    failed: !!failed,
    provider: result?.provider || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// Junta os pedaços da sessão em ordem. Pedaço que não decifra com esta chave
// (não deveria acontecer: a chave é derivada da DEK + sessão) é ignorado e
// contado em undecryptable.
async function loadSessionTranscript(db, sessionId, clientKey) {
  const snap = await db.collection(PIECES_COLLECTION).where("sessionId", "==", sessionId).limit(2000).get();
  const docs = snap.docs.map(d => d.data()).sort((a, b) => (a.order - b.order) || String(a.key).localeCompare(String(b.key)));
  const texts = [];
  let durationSec = 0;
  let hallucinatedSegments = 0;
  let failedSegments = 0;
  let undecryptable = 0;
  for (const piece of docs) {
    durationSec += Number(piece.durationSec) || 0;
    if (piece.failed) failedSegments += 1;
    if (piece.hallucinated) hallucinatedSegments += 1;
    let text = "";
    try {
      text = String(decryptJson({ ciphertext: piece.ciphertext, iv: piece.iv }, clientKey)?.text || "");
    } catch {
      undecryptable += 1;
      continue;
    }
    if (text.trim()) texts.push(text.trim());
  }
  const text = texts.join("\n\n").trim();
  return {
    text,
    durationSec,
    pieces: docs.length,
    hallucinated: !text && docs.length > 0,
    hallucinatedSegments,
    failedSegments,
    undecryptable
  };
}

async function deleteSessionPieces(db, sessionId) {
  const snap = await db.collection(PIECES_COLLECTION).where("sessionId", "==", sessionId).limit(2000).get();
  await deleteDocs(db, snap.docs);
  return snap.size;
}

// Sessões abandonadas (profissional nunca encerrou): o texto parcial expira.
async function sweepOldPieces(db, now = Date.now()) {
  const cutoff = new Date(now - PIECE_TTL_MS);
  const snap = await db.collection(PIECES_COLLECTION).where("createdAt", "<", cutoff).limit(500).get();
  await deleteDocs(db, snap.docs);
  return snap.size;
}

async function deleteDocs(db, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

module.exports = {
  PIECES_COLLECTION,
  isValidPieceKey,
  pieceOrder,
  hasPiece,
  hasAnyPiece,
  storePiece,
  loadSessionTranscript,
  deleteSessionPieces,
  sweepOldPieces
};
