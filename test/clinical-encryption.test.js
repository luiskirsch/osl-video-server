"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { readClientEncryption, encryptJson, decryptJson, encryptedPayloadResponse } = require("../services/clinical-encryption");
const whisper = require("../services/whisper");
const sessionSummary = require("../services/session-summary");
const { processAiSummary } = require("../services/therapy-ai-summary");

test("clinical payload uses authenticated AES-256-GCM", () => {
  const key = crypto.randomBytes(32);
  const payload = { transcript: "conteúdo clínico", summary: { summary: "resumo" } };
  const encrypted = encryptJson(payload, key);
  const bytes = Buffer.from(encrypted.ciphertext, "base64");
  const body = bytes.subarray(0, -16);
  const tag = bytes.subarray(-16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  assert.deepEqual(decoded, payload);
  assert.equal(encrypted.algorithm, "AES-256-GCM");
});

test("clinical decryption preserves existing GCM payloads and rejects tampering", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const payload = { summary: "legacy payload" };
  // Formato anterior: tag padrão de 16 bytes, sem authTagLength explícito.
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const raw = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  const envelope = { iv: iv.toString("base64"), ciphertext: raw.toString("base64") };
  assert.deepEqual(decryptJson(envelope, key), payload);
  assert.deepEqual(decryptJson(encryptJson(payload, key), key), payload);
  const altered = Buffer.from(raw);
  altered[altered.length - 1] ^= 1;
  assert.throws(() => decryptJson({ ...envelope, ciphertext: altered.toString("base64") }, key));
  assert.throws(() => decryptJson({ ...envelope, ciphertext: raw.subarray(0, -4).toString("base64") }, key));
  assert.throws(() => decryptJson(envelope, crypto.randomBytes(32)));
});

test("client encryption headers require exact key and IV sizes", () => {
  const headers = {
    "x-ai-result-key": crypto.randomBytes(32).toString("base64"),
    "x-ai-wrapped-key": crypto.randomBytes(48).toString("base64"),
    "x-ai-wrapped-key-iv": crypto.randomBytes(12).toString("base64"),
  };
  const parsed = readClientEncryption({ get: (name) => headers[name] });
  assert.equal(parsed.key.length, 32);
  assert.throws(() => readClientEncryption({ get: () => "invalid" }), /INVALIDO/);
});

test("encrypted response never returns the transient raw key", () => {
  const response = encryptedPayloadResponse({
    encryptionVersion: 1,
    payloadCiphertext: "ciphertext",
    payloadIv: "iv",
    wrappedKey: "wrapped",
    wrappedKeyIv: "wrapped-iv",
  });
  assert.deepEqual(response, {
    version: 1,
    algorithm: "AES-256-GCM",
    ciphertext: "ciphertext",
    iv: "iv",
    wrappedKey: "wrapped",
    wrappedKeyIv: "wrapped-iv",
  });
  assert.equal("key" in response, false);
});

test("AI pipeline persists no clinical plaintext and clears its transient key", async (t) => {
  const originalTranscribe = whisper.transcribe;
  const originalSummarize = sessionSummary.summarizeSession;
  t.after(() => {
    whisper.transcribe = originalTranscribe;
    sessionSummary.summarizeSession = originalSummarize;
  });
  whisper.transcribe = async () => ({
    text: "conteúdo clínico que deve existir apenas em memória durante o processamento",
    chunks: [],
    durationSec: 60,
    hallucinated: false,
  });
  sessionSummary.summarizeSession = async () => ({
    ok: true,
    summary: { summary: "resumo privado", topics: [], signals: { riskLevel: "none" } },
    usage: { input: 10, output: 5 },
  });

  const writes = [];
  const summaryRef = {};
  const db = {
    collection: () => ({ doc: () => summaryRef }),
    runTransaction: async callback => callback({
      get: async () => ({
        exists: true,
        data: () => ({ status: "processing", attemptId: "attempt-1" }),
      }),
      set: (_ref, value) => writes.push(value),
    }),
  };
  const deleted = Symbol("deleted");
  const admin = { firestore: { FieldValue: {
    delete: () => deleted,
    serverTimestamp: () => "timestamp",
  } } };
  const key = crypto.randomBytes(32);
  await processAiSummary({
    audioBuffer: Buffer.from("audio"),
    sessionId: "session-1",
    attemptId: "attempt-1",
    therapist: { displayName: "Profissional" },
    session: { patientId: "patient-1", patientName: "Paciente" },
    clientEncryption: { key, wrappedKey: "wrapped", wrappedKeyIv: "wrapped-iv" },
    db,
    admin,
  });

  // Além do resultado, o job grava sinais de vida ({ heartbeatAt }) — nenhum
  // deles pode carregar conteúdo clínico.
  const heartbeats = writes.filter(w => Object.keys(w).length === 1 && "heartbeatAt" in w);
  const results = writes.filter(w => !heartbeats.includes(w));
  assert.equal(results.length, 1);
  assert.ok(heartbeats.length >= 1);
  assert.equal(JSON.stringify(writes).includes("conteúdo clínico"), false);
  const stored = results[0];
  assert.equal(stored.summary, deleted);
  assert.equal(stored.signals, deleted);
  assert.equal(stored.transcript, deleted);
  assert.equal(stored.transcriptChunks, deleted);
  assert.ok(stored.payloadCiphertext);
  assert.equal(JSON.stringify(stored).includes("conteúdo clínico"), false);
  assert.equal(key.every((byte) => byte === 0), true);
});
