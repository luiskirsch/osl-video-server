"use strict";

const { logError, logInfo, logWarn } = require("../logger");
const whisper = require("./whisper");
const sessionSummary = require("./session-summary");
const { encryptJson } = require("./clinical-encryption");

async function updateCurrentAttempt({ db, summaryRef, attemptId, data }) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(summaryRef);
    const current = snap.exists ? snap.data() : null;
    if (!current || current.status !== "processing" || current.attemptId !== attemptId) return false;
    tx.set(summaryRef, data, { merge: true });
    return true;
  });
}

const MAX_AUDIO_SEGMENTS = 100;

// Cada recarga/reentrada na sala gera uma gravação WebM própria (não dá pra
// concatenar os bytes). O cliente manda todas no mesmo body e informa o
// tamanho de cada uma em X-AI-Segments; sem o header, é um arquivo único.
function splitAudioSegments(buffer, header) {
  if (header === undefined || header === null || String(header).trim() === "") return [buffer];
  const sizes = String(header).split(",").map(value => Number(value.trim()));
  if (sizes.length > MAX_AUDIO_SEGMENTS || sizes.some(size => !Number.isSafeInteger(size) || size <= 0)) return null;
  if (sizes.reduce((sum, size) => sum + size, 0) !== buffer.length) return null;
  const segments = [];
  let offset = 0;
  for (const size of sizes) {
    segments.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return segments;
}

// Um trecho curto ou corrompido (ex.: a aba recarregou logo após começar) não
// pode derrubar a transcrição dos demais.
async function transcribeSegments(segments, transcribe = whisper.transcribe, context = {}) {
  const texts = [];
  let durationSec = 0;
  let hallucinatedSegments = 0;
  let failedSegments = 0;
  let firstError = null;
  for (const [index, segment] of segments.entries()) {
    let result;
    try {
      result = await transcribe(segment, { language: "portuguese" });
    } catch (error) {
      failedSegments += 1;
      firstError = firstError || error;
      logWarn("ai_summary_segment_failed", { ...context, segment: index, bytes: segment.length, error: error.message });
      continue;
    }
    durationSec += result.durationSec || 0;
    if (result.hallucinated) {
      hallucinatedSegments += 1;
      continue;
    }
    if (result.text) texts.push(result.text);
  }
  if (failedSegments === segments.length) throw firstError;
  const text = texts.join("\n\n").trim();
  return { text, durationSec, hallucinated: !text && hallucinatedSegments > 0, failedSegments, hallucinatedSegments };
}

// Sinal de vida do job: a transcrição em CPU leva ~metade da duração da
// sessão (50 min de áudio ≈ 25 min). Quem lê o status distingue "lento mas
// vivo" de "morto" pelo heartbeat, não por um tempo fixo desde o início.
const HEARTBEAT_MS = 60_000;

async function processAiSummary({ audioBuffer, audioSegments, sessionId, attemptId, therapist, session, clientEncryption, db, admin }) {
  const summaryRef = db.collection("therapy_session_summaries").doc(sessionId);
  const segments = audioSegments || [audioBuffer];
  const beat = () => updateCurrentAttempt({ db, summaryRef, attemptId, data: { heartbeatAt: Date.now() } })
    .catch(err => logWarn("ai_summary_heartbeat_failed", { sessionId, error: err.message }));
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    logInfo("ai_summary_started", {
      sessionId,
      audioBytes: segments.reduce((sum, segment) => sum + segment.length, 0),
      segments: segments.length
    });
    const transcribeStartedAt = Date.now();
    const transcriptResult = await transcribeSegments(segments, whisper.transcribe, { sessionId });
    const transcribeMs = Date.now() - transcribeStartedAt;
    logInfo("ai_summary_transcribed", {
      sessionId,
      durationSec: transcriptResult.durationSec,
      transcribeMs,
      textChars: transcriptResult.text.length,
      hallucinated: transcriptResult.hallucinated || false,
      failedSegments: transcriptResult.failedSegments,
      hallucinatedSegments: transcriptResult.hallucinatedSegments,
    });

    if (transcriptResult.hallucinated) {
      const stored = await updateCurrentAttempt({ db, summaryRef, attemptId, data: {
        status: "failed",
        error: "TRANSCRIPT_ALUCINADO",
        transcript: admin.firestore.FieldValue.delete(),
        transcriptChunks: admin.firestore.FieldValue.delete(),
        durationSec: transcriptResult.durationSec,
        transcribeMs,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      } });
      if (stored) logWarn("ai_summary_hallucinated", { sessionId, durationSec: transcriptResult.durationSec });
      return;
    }

    const summarizeStartedAt = Date.now();
    const summaryResult = await sessionSummary.summarizeSession({
      transcript: transcriptResult.text,
      professionalName: therapist.displayName || "",
      patientName: session.patientName || "",
      durationSec: transcriptResult.durationSec,
    });
    const summarizeMs = Date.now() - summarizeStartedAt;
    if (!summaryResult.ok) {
      throw new Error(`Summary failed: ${summaryResult.error}${summaryResult.detail ? ` — ${summaryResult.detail}` : ""}`);
    }

    const { signals, ...summary } = summaryResult.summary || {};
    const encrypted = encryptJson({
      summary,
      signals: signals || null,
      transcript: transcriptResult.text,
    }, clientEncryption.key);

    const stored = await updateCurrentAttempt({ db, summaryRef, attemptId, data: {
      status: "completed",
      patientId: session.patientId || null,
      encryptionVersion: encrypted.version,
      encryptionAlgorithm: encrypted.algorithm,
      wrappedKey: clientEncryption.wrappedKey,
      wrappedKeyIv: clientEncryption.wrappedKeyIv,
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      transcript: admin.firestore.FieldValue.delete(),
      transcriptChunks: admin.firestore.FieldValue.delete(),
      summary: admin.firestore.FieldValue.delete(),
      signals: admin.firestore.FieldValue.delete(),
      durationSec: transcriptResult.durationSec,
      transcribeMs,
      summarizeMs,
      tokenUsage: summaryResult.usage || null,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    } });

    if (!stored) {
      logWarn("ai_summary_stale_attempt_discarded", { sessionId, attemptId });
      return;
    }

    logInfo("ai_summary_completed", {
      sessionId,
      totalMs: transcribeMs + summarizeMs,
      inputTokens: summaryResult.usage?.input,
      outputTokens: summaryResult.usage?.output,
    });
  } catch (error) {
    const stored = await updateCurrentAttempt({ db, summaryRef, attemptId, data: {
      status: "failed",
      error: error.message.slice(0, 500),
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    } });
    if (stored) logError("ai_summary_failed", error, { sessionId });
    else logWarn("ai_summary_stale_failure_discarded", { sessionId, attemptId });
  } finally {
    clearInterval(heartbeat);
    clientEncryption?.key?.fill(0);
  }
}

module.exports = { processAiSummary, updateCurrentAttempt, splitAudioSegments, transcribeSegments };
