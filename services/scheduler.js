// Loop periódico do Espaço Prelúdio. Único job atual: dispara e-mail de
// lembrete 24h antes de cada sessão agendada.
//
// Janela: a cada hora, busca sessões com scheduledAt em
// (now + REMINDER_LOOKAHEAD_HOURS - 1h, now + REMINDER_LOOKAHEAD_HOURS].
// Marca reminderSentAt antes de enviar — evita duplicação se o cron rodar
// 2× (rare race). Idempotência fica nesse campo.
//
// Não substitui jobs do `services/cleanup`. Pode coexistir.

const admin = require("firebase-admin");
const { logInfo, logWarn, logError } = require("../logger");
const { getDb } = require("./firestore");
const { REMINDER_LOOKAHEAD_HOURS, ACCESS_TOKEN_SECRET } = require("../config");
const { signPayload } = require("./auth");
const { sendEmail, templateReminder, buildJoinUrl, buildCancelUrl } = require("./email");
const { processPendingReferrals } = require("./affiliate");

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const HOUR_MS = 60 * 60 * 1000;
const JOIN_TOKEN_VALIDITY_MS = 2 * HOUR_MS; // bate com routes/therapy.js

let timer = null;

const REMINDER_CANCEL_VALIDITY_MS = 60 * 24 * 60 * 60 * 1000; // 60d

function buildJoinTokenForSession(session) {
  // Gera fresco — válido na janela de uso (paciente clica no link).
  return signPayload({
    token_type: "therapy_join",
    sessionId: session.sessionId,
    therapistUid: session.therapistUid,
    livekitRoom: session.livekitRoom,
    patientNameHint: session.patientName,
    iat: Date.now(),
    exp: Date.now() + JOIN_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);
}

function buildCancelTokenForSession(sessionId) {
  return signPayload({
    token_type: "session_cancel",
    sessionId,
    iat: Date.now(),
    exp: Date.now() + REMINDER_CANCEL_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);
}

async function runReminderTick() {
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  const lookaheadEnd   = now + REMINDER_LOOKAHEAD_HOURS * HOUR_MS;
  const lookaheadStart = lookaheadEnd - HOUR_MS;

  // Sem orderBy (composite index). Pegamos todas as scheduled num horizonte
  // amplo (1d adiante) e filtramos client-side. Para 1 terapeuta e ~50
  // sessões/semana, fica razoável.
  const snap = await db.collection("therapy_sessions")
    .where("status", "==", "scheduled")
    .limit(500)
    .get();

  let candidates = 0, sent = 0, errors = 0;
  for (const doc of snap.docs) {
    const s = doc.data();
    const at = Number(s.scheduledAt || 0);
    if (!at || at <= lookaheadStart || at > lookaheadEnd) continue;
    if (s.reminderSentAt) continue;
    if (!s.patientEmail) continue; // sem e-mail, no-op silencioso
    candidates++;

    // Marca antes de enviar pra evitar duplicação se este tick crashar.
    try {
      await doc.ref.set({
        reminderSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      logError("reminder_mark_failed", e, { sessionId: s.sessionId });
      errors++;
      continue;
    }

    try {
      const joinToken   = buildJoinTokenForSession(s);
      const cancelToken = buildCancelTokenForSession(s.sessionId);
      const tpl = templateReminder({
        patientName: s.patientName || "Paciente",
        therapistName: s.therapistDisplayName || "seu profissional",
        scheduledAt: at,
        joinUrl:   buildJoinUrl(joinToken),
        cancelUrl: buildCancelUrl(cancelToken)
      });
      const result = await sendEmail({ to: s.patientEmail, replyTo: s.therapistEmail || undefined, ...tpl });
      if (!result.ok && !result.skipped) {
        // Reverte reminderSentAt pra retry no próximo tick.
        await doc.ref.set({ reminderSentAt: null }, { merge: true });
        errors++;
        continue;
      }
      sent++;
    } catch (e) {
      logError("reminder_send_failed", e, { sessionId: s.sessionId });
      try { await doc.ref.set({ reminderSentAt: null }, { merge: true }); } catch {}
      errors++;
    }
  }

  if (candidates > 0 || errors > 0) {
    logInfo("reminder_tick", { candidates, sent, errors, lookaheadHours: REMINDER_LOOKAHEAD_HOURS });
  }
}

async function runFullTick() {
  await runReminderTick().catch(e => logError("reminder_tick_unhandled", e));
  // #B1: processa fila de retries de afiliado todo tick (1×/h é suficiente —
  // backoff mínimo é 1min mas pra batch isso fica adequado).
  await processPendingReferrals().catch(e => logError("affiliate_retry_tick_unhandled", e));
  // LGPD: apaga fileBase64 de comprovantes-estudante com mais de 90 dias.
  // Mantém metadados (decision, reasons) pra audit.
  await runStudentDocCleanup().catch(e => logError("student_doc_cleanup_unhandled", e));
}

// Itera therapy_student_docs/{uid}/uploads/* e apaga fileBase64 quando
// uploadedAt >= STUDENT_DOC_RETENTION_DAYS atrás. Mantém o doc e os metadados
// pra audit. Roda 1×/h junto do reminder tick — barato, idempotente.
const STUDENT_DOC_RETENTION_DAYS = 90;
const STUDENT_DOC_CLEANUP_BATCH  = 200;

async function runStudentDocCleanup() {
  const db = getDb();
  if (!db) return;

  const cutoffMs = Date.now() - STUDENT_DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);

  // collectionGroup pega todos os subdocs "uploads" de qualquer therapist.
  const snap = await db.collectionGroup("uploads")
    .where("uploadedAt", "<=", cutoff)
    .limit(STUDENT_DOC_CLEANUP_BATCH)
    .get();

  if (snap.empty) return;

  let cleaned = 0, errors = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data.fileBase64) continue; // já limpo
    // Sanity check: só processa docs que parecem ser de comprovante-estudante
    // (pode haver outras "uploads" subcollections no futuro).
    if (!data.therapistUid || !data.fileHash) continue;
    try {
      await doc.ref.update({
        fileBase64: admin.firestore.FieldValue.delete(),
        fileBase64DeletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      cleaned++;
    } catch (e) {
      logError("student_doc_cleanup_delete_failed", e, { uploadId: data.uploadId });
      errors++;
    }
  }

  if (cleaned > 0 || errors > 0) {
    logInfo("student_doc_cleanup_tick", { cleaned, errors, batchSize: snap.size, retentionDays: STUDENT_DOC_RETENTION_DAYS });
  }
}

function startSchedulerLoop() {
  if (timer) return;
  // Primeiro tick depois de 1min (evita bater no startup do Firebase Admin).
  setTimeout(() => {
    runFullTick();
    timer = setInterval(runFullTick, TICK_INTERVAL_MS);
    timer.unref();
  }, 60 * 1000);
  logInfo("scheduler_loop_started", { intervalMs: TICK_INTERVAL_MS, lookaheadHours: REMINDER_LOOKAHEAD_HOURS });
}

function stopSchedulerLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startSchedulerLoop, stopSchedulerLoop, runReminderTick, runStudentDocCleanup };
