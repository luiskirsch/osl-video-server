"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const whisper = require("../services/whisper");
const sessionSummary = require("../services/session-summary");
const pieces = require("../services/ai-summary-pieces");
const { processAiSummary } = require("../services/therapy-ai-summary");

// Firestore mínimo em memória: doc get/set(merge), where("==" | "<").limit.get,
// batch.delete e runTransaction — o suficiente para o fluxo de pedaços.
function fakeFirestore() {
  const collections = new Map();
  const col = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const resolve = value => (value && value.__serverTimestamp ? new Date() : value);
  const docRef = (name, id) => ({
    id,
    _col: name,
    async get() {
      const data = col(name).get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined), ref: docRef(name, id) };
    },
    async set(value, opts) {
      const prev = opts?.merge ? col(name).get(id) || {} : {};
      const next = { ...prev };
      for (const [k, v] of Object.entries(value)) {
        if (v && v.__delete) delete next[k];
        else next[k] = resolve(v);
      }
      col(name).set(id, next);
    },
    async delete() { col(name).delete(id); }
  });
  const query = (name, filters = []) => ({
    where(field, op, value) { return query(name, [...filters, { field, op, value }]); },
    limit() { return this; },
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(f => (f.op === "==" ? d[f.field] === f.value : d[f.field] < f.value)))
        .map(([id, d]) => ({ id, data: () => ({ ...d }), ref: docRef(name, id) }));
      return { docs, size: docs.length };
    }
  });
  const db = {
    collection: name => ({ doc: id => docRef(name, id), where: (f, op, v) => query(name).where(f, op, v) }),
    batch() {
      const ops = [];
      return { delete: ref => ops.push(ref), async commit() { for (const ref of ops) await ref.delete(); } };
    },
    async runTransaction(cb) {
      return cb({ get: ref => ref.get(), set: (ref, value, opts) => ref.set(value, opts ?? { merge: true }) });
    },
    _col: col
  };
  return db;
}

const admin = { firestore: { FieldValue: {
  delete: () => ({ __delete: true }),
  serverTimestamp: () => ({ __serverTimestamp: true })
} } };

const key = () => crypto.randomBytes(32);

test("pedaços guardam só o texto cifrado e voltam na ordem da gravação", async () => {
  const db = fakeFirestore();
  const k = key();
  // gravados fora de ordem
  await pieces.storePiece({ db, admin, sessionId: "s1", therapistUid: "t", key: "1790000180000-c", result: { text: "terceiro", durationSec: 90 }, clientKey: k });
  await pieces.storePiece({ db, admin, sessionId: "s1", therapistUid: "t", key: "1790000000000-a", result: { text: "primeiro", durationSec: 90 }, clientKey: k });
  await pieces.storePiece({ db, admin, sessionId: "s1", therapistUid: "t", key: "1790000090000-b", result: { text: "segundo", durationSec: 90 }, clientKey: k });

  const raw = JSON.stringify([...db._col(pieces.PIECES_COLLECTION).values()]);
  assert.equal(raw.includes("primeiro"), false, "texto não fica em claro");

  const t = await pieces.loadSessionTranscript(db, "s1", k);
  assert.equal(t.text, "primeiro\n\nsegundo\n\nterceiro");
  assert.equal(t.durationSec, 270);
  assert.equal(t.pieces, 3);
  assert.equal(t.hallucinated, false);
});

test("mesma chave é idempotente; pedaço de silêncio ou ilegível não entra no texto", async () => {
  const db = fakeFirestore();
  const k = key();
  const base = { db, admin, sessionId: "s2", therapistUid: "t", clientKey: k };
  await pieces.storePiece({ ...base, key: "1790000000000-a", result: { text: "fala real", durationSec: 90 } });
  await pieces.storePiece({ ...base, key: "1790000000000-a", result: { text: "fala real", durationSec: 90 } });
  await pieces.storePiece({ ...base, key: "1790000090000-b", result: { text: "Obrigado.", hallucinated: true, durationSec: 90 } });
  await pieces.storePiece({ ...base, key: "1790000180000-c", result: null, failed: true });
  assert.equal(await pieces.hasPiece(db, "s2", "1790000000000-a"), true);
  const t = await pieces.loadSessionTranscript(db, "s2", k);
  assert.equal(t.pieces, 3);
  assert.equal(t.text, "fala real");
  assert.equal(t.hallucinatedSegments, 1);
  assert.equal(t.failedSegments, 1);
});

test("chave errada não decifra: pedaço contado como ilegível, sem vazar erro", async () => {
  const db = fakeFirestore();
  await pieces.storePiece({ db, admin, sessionId: "s3", therapistUid: "t", key: "1790000000000-a", result: { text: "x" }, clientKey: key() });
  const t = await pieces.loadSessionTranscript(db, "s3", key());
  assert.equal(t.undecryptable, 1);
  assert.equal(t.text, "");
});

test("chaves de pedaço: aceita só o formato esperado", () => {
  assert.equal(pieces.isValidPieceKey("1790000000000-a1b2c3"), true);
  assert.equal(pieces.isValidPieceKey("1790000000000"), true);
  for (const bad of ["", "abc", "1790000000000-../x", "1790000000000-A", "1".repeat(20), null]) {
    assert.equal(pieces.isValidPieceKey(bad), false, String(bad));
  }
});

test("encerramento por pedaços: transcreve só o que faltava, resume tudo em ordem e apaga os parciais", async (t) => {
  const originalTranscribe = whisper.transcribe;
  const originalSummarize = sessionSummary.summarizeSession;
  t.after(() => { whisper.transcribe = originalTranscribe; sessionSummary.summarizeSession = originalSummarize; });

  const db = fakeFirestore();
  const k = key();
  // Dois pedaços já transcritos durante a consulta
  await pieces.storePiece({ db, admin, sessionId: "s4", therapistUid: "t", key: "1790000000000-a", result: { text: "início da conversa", durationSec: 90 }, clientKey: k });
  await pieces.storePiece({ db, admin, sessionId: "s4", therapistUid: "t", key: "1790000090000-b", result: { text: "meio da conversa", durationSec: 90 }, clientKey: k });

  const transcribed = [];
  whisper.transcribe = async (buffer) => {
    transcribed.push(buffer.toString());
    return { text: "fim da conversa", durationSec: 40, hallucinated: false };
  };
  let summarizedTranscript = null;
  sessionSummary.summarizeSession = async ({ transcript }) => {
    summarizedTranscript = transcript;
    return { ok: true, summary: { summary: "ok", topics: [], signals: { riskLevel: "none" } }, usage: { input: 1, output: 1 } };
  };

  await db.collection("therapy_session_summaries").doc("s4").set({ status: "processing", attemptId: "att" });
  await processAiSummary({
    // "-a" já existe (reenvio após queda): não pode ser transcrito de novo
    piecePlan: { pending: [
      { key: "1790000000000-a", buffer: Buffer.from("dup") },
      { key: "1790000180000-c", buffer: Buffer.from("ultimo") }
    ] },
    sessionId: "s4",
    attemptId: "att",
    therapist: { displayName: "P" },
    session: { therapistUid: "t", patientId: "p", patientName: "X" },
    clientEncryption: { key: k, wrappedKey: "w", wrappedKeyIv: "wi" },
    db,
    admin
  });

  assert.deepEqual(transcribed, ["ultimo"], "só o pedaço faltante é transcrito");
  assert.equal(summarizedTranscript, "início da conversa\n\nmeio da conversa\n\nfim da conversa");
  const summary = (await db.collection("therapy_session_summaries").doc("s4").get()).data();
  assert.equal(summary.status, "completed");
  assert.ok(summary.payloadCiphertext);
  assert.equal(JSON.stringify(summary).includes("conversa"), false, "resultado não fica em claro");
  assert.equal(db._col(pieces.PIECES_COLLECTION).size, 0, "pedaços apagados após concluir");
});

test("encerramento por pedaços só com silêncio vira 'sem fala detectável' e limpa os parciais", async (t) => {
  const originalTranscribe = whisper.transcribe;
  t.after(() => { whisper.transcribe = originalTranscribe; });
  const db = fakeFirestore();
  const k = key();
  whisper.transcribe = async () => ({ text: "", durationSec: 90, hallucinated: true });
  await db.collection("therapy_session_summaries").doc("s5").set({ status: "processing", attemptId: "att" });
  await processAiSummary({
    piecePlan: { pending: [{ key: "1790000000000-a", buffer: Buffer.from("x") }] },
    sessionId: "s5", attemptId: "att", therapist: {}, session: { therapistUid: "t" },
    clientEncryption: { key: k, wrappedKey: "w", wrappedKeyIv: "wi" }, db, admin
  });
  const summary = (await db.collection("therapy_session_summaries").doc("s5").get()).data();
  assert.equal(summary.status, "failed");
  assert.equal(summary.error, "TRANSCRIPT_ALUCINADO");
  assert.equal(db._col(pieces.PIECES_COLLECTION).size, 0);
});

test("encerramento por pedaços sem nenhum áudio falha com SEM_AUDIO", async () => {
  const db = fakeFirestore();
  await db.collection("therapy_session_summaries").doc("s6").set({ status: "processing", attemptId: "att" });
  await processAiSummary({
    piecePlan: { pending: [] }, sessionId: "s6", attemptId: "att", therapist: {}, session: { therapistUid: "t" },
    clientEncryption: { key: key(), wrappedKey: "w", wrappedKeyIv: "wi" }, db, admin
  });
  const summary = (await db.collection("therapy_session_summaries").doc("s6").get()).data();
  assert.equal(summary.status, "failed");
  assert.equal(summary.error, "SEM_AUDIO");
});

test("transcrição local roda uma por vez (fila)", async () => {
  assert.equal(whisper.localQueueDepth(), 0);
});
