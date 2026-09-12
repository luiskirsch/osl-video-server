"use strict";

const { logError, logInfo, logWarn } = require("../logger");
const whisper = require("./whisper");
const sessionSummary = require("./session-summary");
const { encryptJson } = require("./clinical-encryption");

async function processAiSummary({ audioBuffer, sessionId, therapist, session, clientEncryption, db, admin }) {
  const summaryRef = db.collection("therapy_session_summaries").doc(sessionId);

  try {
    logInfo("ai_summary_started", { sessionId, audioBytes: audioBuffer.length });
    const transcribeStartedAt = Date.now();
    const transcriptResult = await whisper.transcribe(audioBuffer, { language: "portuguese" });
    const transcribeMs = Date.now() - transcribeStartedAt;
    logInfo("ai_summary_transcribed", {
      sessionId,
      durationSec: transcriptResult.durationSec,
      transcribeMs,
      textChars: transcriptResult.text.length,
      hallucinated: transcriptResult.hallucinated || false,
    });

    if (transcriptResult.hallucinated) {
      await summaryRef.set({
        status: "failed",
        error: "TRANSCRIPT_ALUCINADO",
        transcript: admin.firestore.FieldValue.delete(),
        transcriptChunks: admin.firestore.FieldValue.delete(),
        durationSec: transcriptResult.durationSec,
        transcribeMs,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logWarn("ai_summary_hallucinated", { sessionId, durationSec: transcriptResult.durationSec });
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

    await summaryRef.set({
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
    }, { merge: true });

    logInfo("ai_summary_completed", {
      sessionId,
      totalMs: transcribeMs + summarizeMs,
      inputTokens: summaryResult.usage?.input,
      outputTokens: summaryResult.usage?.output,
    });
  } catch (error) {
    await summaryRef.set({
      status: "failed",
      error: error.message.slice(0, 500),
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logError("ai_summary_failed", error, { sessionId });
  } finally {
    clientEncryption?.key?.fill(0);
  }
}

module.exports = { processAiSummary };
