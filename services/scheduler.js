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
const { sendEmail, templateReminder, templateBirthday, templateNps, buildJoinUrl, buildCancelUrl, buildConfirmUrl, buildNpsUrl } = require("./email");
const { sendReminder: sendWaReminder } = require("./whatsapp");
const { processPendingReferrals } = require("./affiliate");

// Intervalo do tick principal. 15min é fino o suficiente pra cobrir o
// reminder de 1h (paciente recebe entre T-75min e T-60min). Os outros
// jobs (NPS, aniversário, cleanup) também rodam a cada tick mas têm
// idempotência própria.
const TICK_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const JOIN_TOKEN_VALIDITY_MS = 2 * HOUR_MS; // bate com routes/therapy.js

let timer = null;

const REMINDER_CANCEL_VALIDITY_MS = 60 * 24 * 60 * 60 * 1000; // 60d
const REMINDER_CONFIRM_VALIDITY_MS = REMINDER_CANCEL_VALIDITY_MS;

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

function buildConfirmTokenForSession(sessionId) {
  return signPayload({
    token_type: "session_confirm",
    sessionId,
    iat: Date.now(),
    exp: Date.now() + REMINDER_CONFIRM_VALIDITY_MS
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

  let candidates = 0, sent = 0, errors = 0, waSent = 0;
  for (const doc of snap.docs) {
    const s = doc.data();
    const at = Number(s.scheduledAt || 0);
    if (!at || at <= lookaheadStart || at > lookaheadEnd) continue;
    if (s.reminderSentAt) continue;
    // Sem nenhum canal de contato (email NEM phone) → no-op
    if (!s.patientEmail && !s.patientPhone) continue;
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

    const joinToken    = buildJoinTokenForSession(s);
    const cancelToken  = buildCancelTokenForSession(s.sessionId);
    const confirmToken = buildConfirmTokenForSession(s.sessionId);
    const joinUrl    = buildJoinUrl(joinToken);
    const cancelUrl  = buildCancelUrl(cancelToken);
    const confirmUrl = buildConfirmUrl(confirmToken);

    // E-mail (canal primário, mais antigo).
    let emailOk = false;
    if (s.patientEmail) {
      try {
        const tpl = templateReminder({
          patientName: s.patientName || "Paciente",
          therapistName: s.therapistDisplayName || "seu profissional",
          scheduledAt: at,
          joinUrl, cancelUrl, confirmUrl
        });
        const result = await sendEmail({ to: s.patientEmail, replyTo: s.therapistEmail || undefined, ...tpl });
        emailOk = result.ok || result.skipped;
        if (!emailOk) errors++;
      } catch (e) {
        logError("reminder_email_failed", e, { sessionId: s.sessionId });
      }
    } else {
      emailOk = true; // no-op não conta como erro
    }

    // WhatsApp (canal secundário). Só envia se o therapist tem
    // whatsappConfig.enabled — busca lazy do doc.
    if (s.patientPhone) {
      try {
        const tsnap = await getDb().collection("therapists").doc(s.therapistUid).get();
        const therapist = tsnap.exists ? tsnap.data() : null;
        if (therapist?.whatsappConfig?.enabled) {
          const session = {
            patientName: s.patientName, patientPhone: s.patientPhone,
            scheduledAt: at
          };
          const r = await sendWaReminder({ session, therapist, joinUrl, cancelUrl });
          if (r.ok) waSent++;
        }
      } catch (e) {
        logError("reminder_wa_failed", e, { sessionId: s.sessionId });
      }
    }

    // Se nenhum canal funcionou (e tinha algum pra tentar), reverte
    // reminderSentAt pra retry. Caso contrário, conta como enviado.
    if (!emailOk && !s.patientEmail) {
      // não tinha email, não tinha como falhar nele
    }
    if (!emailOk && s.patientEmail) {
      await doc.ref.set({ reminderSentAt: null }, { merge: true });
      continue;
    }
    sent++;
  }

  if (candidates > 0 || errors > 0) {
    logInfo("reminder_tick", { candidates, sent, waSent, errors, lookaheadHours: REMINDER_LOOKAHEAD_HOURS });
  }
}

// Reminder T-1h: dispara para sessões cujo scheduledAt cai em
// (now + 30min, now + 90min). Idempotência via reminder1hSentAt.
// Tick é 15min, então cada sessão entra na janela em ~4 ticks; primeiro
// marca, demais skipam.
//
// Razão de existir além do 24h: reduz no-show drástico — paciente já viu
// o lembrete da manhã anterior + recebe um "tá começando" colado no
// horário. Padrão de mercado (Doctoralia, iClinic) reporta queda de
// ~30-40% de faltas com 2 lembretes vs. 1.
const REMINDER_1H_WINDOW_START_MS = 30 * 60 * 1000;
const REMINDER_1H_WINDOW_END_MS   = 90 * 60 * 1000;

async function runReminder1hTick() {
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  const windowStart = now + REMINDER_1H_WINDOW_START_MS;
  const windowEnd   = now + REMINDER_1H_WINDOW_END_MS;

  const snap = await db.collection("therapy_sessions")
    .where("status", "==", "scheduled")
    .limit(500)
    .get();

  let candidates = 0, sent = 0, errors = 0, waSent = 0;
  for (const doc of snap.docs) {
    const s = doc.data();
    const at = Number(s.scheduledAt || 0);
    if (!at || at <= windowStart || at > windowEnd) continue;
    if (s.reminder1hSentAt) continue;
    if (!s.patientEmail && !s.patientPhone) continue;
    candidates++;

    try {
      await doc.ref.set({
        reminder1hSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      logError("reminder_1h_mark_failed", e, { sessionId: s.sessionId });
      errors++;
      continue;
    }

    const joinToken    = buildJoinTokenForSession(s);
    const cancelToken  = buildCancelTokenForSession(s.sessionId);
    const confirmToken = buildConfirmTokenForSession(s.sessionId);
    const joinUrl    = buildJoinUrl(joinToken);
    const cancelUrl  = buildCancelUrl(cancelToken);
    const confirmUrl = buildConfirmUrl(confirmToken);

    let emailOk = false;
    if (s.patientEmail) {
      try {
        const tpl = templateReminder({
          patientName: s.patientName || "Paciente",
          therapistName: s.therapistDisplayName || "seu profissional",
          scheduledAt: at,
          joinUrl, cancelUrl, confirmUrl
        });
        const result = await sendEmail({ to: s.patientEmail, replyTo: s.therapistEmail || undefined, ...tpl });
        emailOk = result.ok || result.skipped;
        if (!emailOk) errors++;
      } catch (e) {
        logError("reminder_1h_email_failed", e, { sessionId: s.sessionId });
      }
    } else {
      emailOk = true;
    }

    if (s.patientPhone) {
      try {
        const tsnap = await getDb().collection("therapists").doc(s.therapistUid).get();
        const therapist = tsnap.exists ? tsnap.data() : null;
        if (therapist?.whatsappConfig?.enabled) {
          const session = {
            patientName: s.patientName, patientPhone: s.patientPhone,
            scheduledAt: at
          };
          const r = await sendWaReminder({ session, therapist, joinUrl, cancelUrl });
          if (r.ok) waSent++;
        }
      } catch (e) {
        logError("reminder_1h_wa_failed", e, { sessionId: s.sessionId });
      }
    }

    if (!emailOk && s.patientEmail) {
      await doc.ref.set({ reminder1hSentAt: null }, { merge: true });
      continue;
    }
    sent++;
  }

  if (candidates > 0 || errors > 0) {
    logInfo("reminder_1h_tick", { candidates, sent, waSent, errors });
  }
}

async function runFullTick() {
  await runReminderTick().catch(e => logError("reminder_tick_unhandled", e));
  await runReminder1hTick().catch(e => logError("reminder_1h_tick_unhandled", e));
  // #B1: processa fila de retries de afiliado todo tick (1×/h é suficiente —
  // backoff mínimo é 1min mas pra batch isso fica adequado).
  await processPendingReferrals().catch(e => logError("affiliate_retry_tick_unhandled", e));
  // LGPD: apaga fileBase64 de comprovantes-estudante com mais de 90 dias.
  // Mantém metadados (decision, reasons) pra audit.
  await runStudentDocCleanup().catch(e => logError("student_doc_cleanup_unhandled", e));
  // Aniversariantes: dispara 1×/dia às 9h BRT (=12h UTC). Idempotência via
  // lastSentAt comparado com a data de hoje (YYYY-MM-DD).
  await runBirthdayTick().catch(e => logError("birthday_tick_unhandled", e));
  // NPS: 24h após sessão completada, dispara pesquisa por e-mail.
  await runNpsTick().catch(e => logError("nps_tick_unhandled", e));
}

// ─── NPS pós-consulta ────────────────────────────────────────────────
// Roda a cada hora. Busca sessões completadas entre 24h e 48h atrás (janela
// suficiente pra o scheduler pegar mesmo se rodar atrasado). Idempotência:
// salva `npsSentAt` no doc da sessão; pula se já tem.

const NPS_WINDOW_START_MS = 24 * 60 * 60 * 1000;  // 24h após completar
const NPS_WINDOW_END_MS   = 48 * 60 * 60 * 1000;  // até 48h após
const NPS_TOKEN_VALIDITY_MS_SCH = 30 * 24 * 60 * 60 * 1000;

async function runNpsTick() {
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  const windowEnd   = now - NPS_WINDOW_START_MS; // sessão completou antes disso
  const windowStart = now - NPS_WINDOW_END_MS;   // mas não antes disso

  // Query: status=completed e completedAt na janela. completedAt pode ser
  // Firestore Timestamp ou número — filtramos depois.
  const snap = await db.collection("therapy_sessions")
    .where("status", "==", "completed")
    .limit(500)
    .get();

  let candidates = 0, sent = 0, skipped = 0, errors = 0;
  for (const doc of snap.docs) {
    const s = doc.data();
    const completedAtMs = s.completedAt?.toMillis ? s.completedAt.toMillis() : Number(s.completedAt) || 0;
    if (!completedAtMs) continue;
    if (completedAtMs < windowStart || completedAtMs > windowEnd) continue;
    if (s.npsSentAt) { skipped++; continue; }
    if (!s.patientEmail) { skipped++; continue; }

    candidates++;
    // Marca antes pra evitar dupla — se enviar falhar, próximo tick não retenta (aceitável).
    try {
      await doc.ref.set({
        npsSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      logError("nps_mark_failed", e, { sessionId: s.sessionId });
      errors++;
      continue;
    }

    // Busca therapist pra incluir nome no template.
    let therapistName = "seu profissional";
    try {
      const tsnap = await db.collection("therapists").doc(s.therapistUid).get();
      if (tsnap.exists) therapistName = tsnap.data().displayName || therapistName;
    } catch {}

    // Token assinado.
    const npsToken = signPayload({
      token_type: "nps",
      sessionId: s.sessionId,
      therapistUid: s.therapistUid,
      patientEmail: s.patientEmail,
      patientNameHint: s.patientName || "",
      iat: Date.now(),
      exp: Date.now() + NPS_TOKEN_VALIDITY_MS_SCH
    }, ACCESS_TOKEN_SECRET);

    const npsUrl = buildNpsUrl(npsToken);

    try {
      const tpl = templateNps({
        patientName: s.patientName || "Paciente",
        therapistName,
        npsUrl
      });
      const r = await sendEmail({ to: s.patientEmail, ...tpl });
      if (r.ok || r.skipped) sent++;
      else errors++;
    } catch (e) {
      logError("nps_email_failed", e, { sessionId: s.sessionId });
      errors++;
    }
  }

  if (candidates > 0 || errors > 0) {
    logInfo("nps_tick", { candidates, sent, skipped, errors });
  }
}

// ─── Aniversariantes ─────────────────────────────────────────────────
// Roda 1×/dia. Como o scheduler já gira de hora em hora (runFullTick),
// usamos uma "janela" de hora alvo (9h BRT) + lastSentAt como guard idempotente.
// Sem cron dedicado pra não introduzir nova dependência.

const BIRTHDAY_TARGET_HOUR_BRT = 9; // hora local brasileira de envio
const BIRTHDAY_TARGET_HOUR_UTC = 12; // ~9h BRT (sem DST no Brasil desde 2019)

async function runBirthdayTick() {
  const db = getDb();
  if (!db) return;

  const now = new Date();
  // Só dispara na "janela" da hora alvo. Outros ticks do dia passam batido.
  if (now.getUTCHours() !== BIRTHDAY_TARGET_HOUR_UTC) return;

  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayMMDD = `${mm}${dd}`;
  const todayYMD  = `${now.getUTCFullYear()}-${mm}-${dd}`;

  const snap = await db.collection("therapy_birthday_optins")
    .where("birthMonthDay", "==", todayMMDD)
    .limit(500)
    .get();

  if (snap.empty) return;

  let sent = 0, skipped = 0, errors = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    // Idempotência: se já enviou hoje, pula. Compara dia (não timestamp exato)
    // pra cobrir reruns dentro do mesmo dia (ex.: scheduler reiniciado).
    const lastSentMs = o.lastSentAt?.toMillis ? o.lastSentAt.toMillis() : Number(o.lastSentAt) || 0;
    if (lastSentMs) {
      const last = new Date(lastSentMs);
      const lastYMD = `${last.getUTCFullYear()}-${String(last.getUTCMonth()+1).padStart(2,"0")}-${String(last.getUTCDate()).padStart(2,"0")}`;
      if (lastYMD === todayYMD) { skipped++; continue; }
    }

    // Busca o therapist pra montar nome no template.
    let therapistName = "";
    let clinicName = "";
    try {
      const tsnap = await db.collection("therapists").doc(o.therapistUid).get();
      if (tsnap.exists) {
        const t = tsnap.data();
        therapistName = t.displayName || "";
        clinicName    = t.consultorio?.nome || t.whatsappConfig?.clinicName || "";
      }
    } catch (e) { /* segue com defaults */ }

    try {
      const tpl = templateBirthday({
        patientName: o.patientName,
        therapistName,
        clinicName
      });
      const r = await sendEmail({ to: o.patientEmail, ...tpl });
      if (r.ok || r.skipped) {
        await doc.ref.set({
          lastSentAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        sent++;
      } else {
        errors++;
      }
    } catch (e) {
      logError("birthday_email_failed", e, { optinId: o.optinId });
      errors++;
    }
  }

  if (sent > 0 || errors > 0) {
    logInfo("birthday_tick", { matched: snap.size, sent, skipped, errors, todayMMDD });
  }
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

module.exports = { startSchedulerLoop, stopSchedulerLoop, runReminderTick, runReminder1hTick, runStudentDocCleanup, runBirthdayTick, runNpsTick };
