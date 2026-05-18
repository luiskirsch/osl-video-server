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
const { sendEmail, templateReminder, templateBirthday, templateNps, templateStudentExpired, templateRecemFormadoEndingSoon, buildJoinUrl, buildCancelUrl, buildConfirmUrl, buildNpsUrl, buildPlanosUrl, buildComprovanteEstudanteUrl } = require("./email");
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
  await processPendingReferrals().catch(e => logError("affiliate_retry_tick_unhandled", e));
  await runStudentDocCleanup().catch(e => logError("student_doc_cleanup_unhandled", e));
  await runBirthdayTick().catch(e => logError("birthday_tick_unhandled", e));
  await runNpsTick().catch(e => logError("nps_tick_unhandled", e));
  // Chat: dispara e-mail fallback pra threads com mensagem unread > 24h
  // (best-effort caso push notification tenha falhado ou user esteja off).
  await runChatUnreadEmailTick().catch(e => logError("chat_unread_tick_unhandled", e));
  // Reverificação anual de tiers (estudante expira / recém-formado vira pro)
  await runStudentExpirationTick().catch(e => logError("student_expiration_tick_unhandled", e));
  await runRecemFormadoTransitionTick().catch(e => logError("recem_formado_transition_tick_unhandled", e));
}

// ─── Chat: e-mail fallback pra unread > 24h ──────────────────────────
// Busca threads com lastMessageAt > 24h e lastRead{receiver} < lastMessageAt
// + nenhum e-mail fallback enviado pra esse "ciclo" (idempotência via
// lastChatEmailFallbackAt). Envia "você tem mensagem não lida".

const CHAT_UNREAD_THRESHOLD_MS = 24 * 60 * 60 * 1000;     // 24h
const CHAT_EMAIL_COOLDOWN_MS   = 7 * 24 * 60 * 60 * 1000; // 7d entre fallbacks

async function runChatUnreadEmailTick() {
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  const threshold = now - CHAT_UNREAD_THRESHOLD_MS;

  // Lê threads recentes (last message nos últimos 30d). Filtra in-memory.
  const ageLimit = now - (30 * 24 * 60 * 60 * 1000);
  const snap = await db.collection("therapy_threads")
    .where("lastMessageAt", ">=", new Date(ageLimit))
    .limit(500).get();

  let sent = 0, skipped = 0;
  for (const doc of snap.docs) {
    const t = doc.data();
    const lastMsgMs = t.lastMessageAt?.toMillis ? t.lastMessageAt.toMillis() : Number(t.lastMessageAt) || 0;
    if (!lastMsgMs || lastMsgMs > threshold) { skipped++; continue; }
    // Quem é o receiver (não-sender da última mensagem) e a leitura dele?
    const senderRole = t.lastMessageSenderRole;
    if (!senderRole) { skipped++; continue; }
    const receiverRole = senderRole === "therapist" ? "patient" : "therapist";
    const receiverLastRead = receiverRole === "therapist"
      ? (Number(t.lastReadByTherapist) || 0)
      : (Number(t.lastReadByPatient)   || 0);
    if (receiverLastRead >= lastMsgMs) { skipped++; continue; } // já leu

    // Cooldown: enviou e-mail fallback pra esse receiver nos últimos 7d? pula.
    const fallbackKey = receiverRole === "therapist" ? "chatFallbackTherapistAt" : "chatFallbackPatientAt";
    const lastFallback = Number(t[fallbackKey]) || 0;
    if (lastFallback && (now - lastFallback) < CHAT_EMAIL_COOLDOWN_MS) { skipped++; continue; }

    const receiverUid = receiverRole === "therapist" ? t.therapistUid : t.patientAccountUid;
    const receiverName = receiverRole === "therapist" ? t.therapistDisplayName : t.patientDisplayName;
    const senderName   = senderRole   === "therapist" ? t.therapistDisplayName : t.patientDisplayName;
    if (!receiverUid) { skipped++; continue; }

    // Resolve e-mail do receiver
    let receiverEmail = null;
    try {
      const userRec = await admin.auth().getUser(receiverUid);
      receiverEmail = userRec.email || null;
    } catch { /* ignore */ }
    if (!receiverEmail) { skipped++; continue; }

    const url = receiverRole === "therapist"
      ? "https://espacopreludio.com.br/mensagens.html"
      : "https://espacopreludio.com.br/paciente-mensagens.html";

    try {
      await sendEmail({
        to: receiverEmail,
        subject: `Você tem uma mensagem não lida no Espaço Prelúdio`,
        html: `
          <p>Olá ${escHtml(receiverName || "")},</p>
          <p><strong>${escHtml(senderName || "Sua conversa")}</strong> te enviou uma mensagem há mais de 24h e ela ainda não foi lida.</p>
          <p style="margin: 22px 0;">
            <a href="${url}" style="display:inline-block;background:#2d4a3e;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:500;">Abrir conversa</a>
          </p>
          <p style="font-size:13px;color:rgba(28,31,29,0.65);">As mensagens são cifradas ponta-a-ponta — só você consegue lê-las após fazer login.</p>
        `,
        text: `Você tem uma mensagem não lida de ${senderName || "—"} no Espaço Prelúdio.\n\nAbra: ${url}`
      });
      // Marca o cooldown
      await doc.ref.set({ [fallbackKey]: now }, { merge: true });
      sent++;
    } catch (e) {
      logWarn("chat_unread_email_send_failed", { threadId: t.threadId, error: e.message });
    }
  }
  if (sent || skipped) logInfo("chat_unread_email_tick", { sent, skipped, totalChecked: snap.size });
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
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

// ─── Reverificação anual ─────────────────────────────────────────────
// Detecta tiers que expiraram e age:
// 1) Estudante: studentVerifiedUntil <= now → downgrade pra trial (7d grace)
//    + email pedindo novo comprovante. Idempotente via plano change.
// 2) Recém-formado: 30d antes do aniversário de 12 meses da dataInscricao →
//    email avisando que vai migrar pra profissional. Idempotente via
//    recemFormadoEndingNoticeSentAt. (Migração automática real do MP
//    preapproval fica pra fase futura — exige PUT em /preapproval/:id
//    com novo transaction_amount.)
//
// Por que aqui: a fonte da verdade do tier vive em therapists/{uid}. O
// tick principal já passa por essa coleção em outras checagens; adicionar
// um query semanal cabe sem custo extra.
const STUDENT_GRACE_DAYS = 7;
const RECEM_FORMADO_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 12 meses
const RECEM_FORMADO_NOTICE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000; // 30d antes

async function runStudentExpirationTick() {
  const db = getDb();
  if (!db) return;

  const now = new Date();
  // Firestore aceita where com Date — converte pra Timestamp internamente.
  const snap = await db.collection("therapists")
    .where("plano", "==", "student-active")
    .where("studentVerifiedUntil", "<=", now)
    .limit(200)
    .get();

  if (snap.empty) return;

  let downgraded = 0, errors = 0;
  for (const doc of snap.docs) {
    const t = doc.data();
    try {
      await doc.ref.set({
        plano: "trial",
        trialUntil: new Date(Date.now() + STUDENT_GRACE_DAYS * 24 * 60 * 60 * 1000),
        studentExpiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Email best-effort — não bloqueia downgrade se falhar
      if (t.email) {
        try {
          const tpl = templateStudentExpired({
            therapistName: t.displayName || "profissional",
            retryUrl: buildComprovanteEstudanteUrl(),
            planosUrl: buildPlanosUrl()
          });
          await sendEmail({ to: t.email, ...tpl });
        } catch (e) {
          logError("student_expired_email_failed", e, { uid: t.uid });
        }
      }
      downgraded++;
    } catch (e) {
      logError("student_expiration_downgrade_failed", e, { uid: t.uid });
      errors++;
    }
  }

  if (downgraded > 0 || errors > 0) {
    logInfo("student_expiration_tick", { downgraded, errors, graceDays: STUDENT_GRACE_DAYS });
  }
}

async function runRecemFormadoTransitionTick() {
  const db = getDb();
  if (!db) return;

  // Busca quem está em plano "pro" com tier recem-formado ATIVO (sem aviso
  // enviado ainda). Não dá pra usar where em campo aninhado de timestamp
  // direto — filtra em memória após query simples por plano+proTier.
  const snap = await db.collection("therapists")
    .where("plano", "==", "pro")
    .where("proTier", "==", "recem-formado")
    .limit(500)
    .get();

  if (snap.empty) return;

  const now = Date.now();
  let notified = 0, errors = 0;
  for (const doc of snap.docs) {
    const t = doc.data();
    if (t.recemFormadoEndingNoticeSentAt) continue; // já avisado

    // dataInscricao vive em recemFormadoDoc.extracted.dataInscricao
    // (string ISO ou "YYYY-MM-DD"). Pode estar ausente em contas antigas.
    const dataInscricaoStr = t.recemFormadoDoc?.extracted?.dataInscricao;
    if (!dataInscricaoStr) continue;

    const inscricaoMs = Date.parse(dataInscricaoStr);
    if (!Number.isFinite(inscricaoMs)) continue;

    const endingMs = inscricaoMs + RECEM_FORMADO_DURATION_MS;
    const noticeAt = endingMs - RECEM_FORMADO_NOTICE_AHEAD_MS;

    // Janela: avisar APENAS se cruzou a marca dos 30d-antes E ainda não
    // cruzou a marca de expiração (caso contrário já passou da hora).
    if (now < noticeAt) continue; // ainda cedo
    if (now >= endingMs) continue; // já expirou — outra cron lida com isso

    try {
      if (t.email) {
        const tpl = templateRecemFormadoEndingSoon({
          therapistName: t.displayName || "profissional",
          endingDateIso: new Date(endingMs).toISOString(),
          planosUrl: buildPlanosUrl()
        });
        await sendEmail({ to: t.email, ...tpl });
      }
      await doc.ref.set({
        recemFormadoEndingNoticeSentAt: admin.firestore.FieldValue.serverTimestamp(),
        recemFormadoEndingDate: new Date(endingMs),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      notified++;
    } catch (e) {
      logError("recem_formado_notice_failed", e, { uid: t.uid });
      errors++;
    }
  }

  if (notified > 0 || errors > 0) {
    logInfo("recem_formado_transition_tick", { notified, errors });
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

module.exports = { startSchedulerLoop, stopSchedulerLoop, runReminderTick, runReminder1hTick, runStudentDocCleanup, runBirthdayTick, runNpsTick, runStudentExpirationTick, runRecemFormadoTransitionTick };
