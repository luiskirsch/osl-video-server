const express = require("express");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError, normalizePathEmail } = require("../utils");
const { activeStreams, pagamentosAprovados } = require("../game/state");
const { normalizeRoomId } = require("../game/rooms");
const { startRoomStreaming, stopRoomStreaming, egressClient } = require("../video/webrtc");
const { getDb, requireFirebaseAuth, requireEmailMatchesToken, isPrestige, isPassActive } = require("../services/firestore");
const { FREE_TIER_DAILY_LIMIT_MIN, MAX_PLATFORMS_PER_STREAM } = require("../config");

const router = express.Router();

// Security #11: rate limit pra evitar abuso de Egress LiveKit ($) e enumeração
// Usa IP + email (quando presente) como chave pra evitar bypass simples por IP rotation.
const startLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 min
  max: 6,                     // 6 starts/min/IP
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_EXCEDIDO", hint: "Tente de novo em 1 min" },
  keyGenerator: (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    return email || (req.ip || "anon");
  }
});

// Limit mais frouxo pra leituras (status/usage/pass/stats/history) — protege de enumeração
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,                    // 30 reads/min/IP
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_EXCEDIDO" }
});

// GET /streaming/pass/:email — verifica se o email tem Stream Pass mensal ativo (ou Prestige)
router.get("/streaming/pass/:email", readLimiter, requireFirebaseAuth, requireEmailMatchesToken, asyncHandler(async (req, res) => {
  const email = normalizePathEmail(req);
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");

  if (await isPrestige(email)) {
    return res.json({ ok: true, active: true, expiresAt: null, type: "prestige" });
  }
  const pass = await isPassActive("streaming_passes", email);
  return res.json({ ok: true, active: pass.active, expiresAt: pass.expiresAt, type: pass.type || "streaming-mensal" });
}));

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Security #5: pré-debita upfront o pior caso (toda quota restante) numa transaction
// pra que N starts concorrentes sejam serializados. /stop refunda o tempo não usado.
async function checkAuthAndReserve(email) {
  if (!email) return { allowed: false, reason: "EMAIL_OBRIGATORIO" };
  const db = getDb();
  if (!db) return { allowed: true, type: "no-firestore" };

  try {
    // 1. Prestige (sem reserva, sem limite de quota)
    if (await isPrestige(email)) {
      return { allowed: true, type: "prestige", reservedMin: 0 };
    }

    // 2. Pass mensal ativo
    const pass = await isPassActive("streaming_passes", email);
    if (pass.active) {
      return { allowed: true, type: "pass", reservedMin: 0, expiresAt: pass.expiresAt };
    }

    // 3. Free tier: transação atomica check + reserve
    const usageRef = db.collection("streaming_usage").doc(`${email}_${todayKey()}`);
    return await db.runTransaction(async tx => {
      const usage = await tx.get(usageRef);
      const used = usage.exists ? Number(usage.data().minutesUsed || 0) : 0;
      const remaining = FREE_TIER_DAILY_LIMIT_MIN - used;
      if (remaining <= 0) {
        return { allowed: false, reason: "QUOTA_DIARIA_ESGOTADA", usedMin: used, remainingMin: 0 };
      }
      const reservedMin = Math.min(FREE_TIER_DAILY_LIMIT_MIN, remaining);
      tx.set(usageRef, {
        email, date: todayKey(),
        minutesUsed: used + reservedMin,
        lastReservation: Date.now()
      }, { merge: true });
      return { allowed: true, type: "free", reservedMin, remainingMin: 0 };
    });
  } catch (err) {
    logError("streaming_auth_reserve_error", err);
    return { allowed: true, type: "auth-error-fallback", reservedMin: 0 };
  }
}

// POST /streaming/start
// body: {
//   roomId,
//   email,                                      (obrigatório pra gating)
//   platforms: [{ name: "youtube"|"twitch"|"facebook"|"kick"|"tiktok"|"custom", streamKey }],
//   layoutId: "cards" | "pov-host" | "grid"     (opcional, default "cards")
// }
// Security #4: /streaming/start agora exige Firebase Bearer token. Email é
// extraído do token (não do body) — impede attacker de iniciar stream usando
// o pass/quota de outro usuário só fornecendo o email dele.
router.post("/streaming/start", startLimiter, requireFirebaseAuth, asyncHandler(async (req, res) => {
  const roomId    = normalizeRoomId(req.body?.roomId);
  const email     = String(req.firebaseUser?.email || "").trim().toLowerCase();
  const platforms = req.body?.platforms;
  const layoutId  = String(req.body?.layoutId || "cards").trim();

  if (!roomId)                            return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!email)                             return sendError(res, 401, "TOKEN_SEM_EMAIL");
  if (!Array.isArray(platforms) || !platforms.length) return sendError(res, 400, "PLATAFORMAS_OBRIGATORIAS");
  if (platforms.length > MAX_PLATFORMS_PER_STREAM) {
    return sendError(res, 400, "MUITAS_PLATAFORMAS", { max: MAX_PLATFORMS_PER_STREAM });
  }
  if (!egressClient)                      return sendError(res, 503, "EGRESS_NAO_CONFIGURADO");

  for (const p of platforms) {
    if (!p?.name)      return sendError(res, 400, "PLATAFORMA_SEM_NOME");
    if (!p?.streamKey) return sendError(res, 400, "STREAM_KEY_OBRIGATORIA");
  }

  // Security #5: gate atomico + reserva de quota
  const auth = await checkAuthAndReserve(email);
  if (!auth.allowed) {
    return sendError(res, 402, auth.reason || "ACESSO_NEGADO", {
      usedMin: auth.usedMin,
      remainingMin: auth.remainingMin,
      hint: "Compre o Stream Pass mensal pra streamar sem limite, ou aguarde 24h pra resetar a quota gratuita."
    });
  }

  let job;
  try {
    job = await startRoomStreaming(roomId, platforms, layoutId);
    job.email       = email;
    job.authType    = auth.type;
    job.reservedMin = auth.reservedMin || 0;
    activeStreams.set(roomId, job);
    return res.json({
      ok: true,
      egressId:  job.egressId,
      platforms: job.platforms,
      layout:    job.layout,
      startedAt: job.startedAt,
      authType:  auth.type,
      remainingMin: auth.remainingMin ?? null
    });
  } catch (err) {
    // CRITICAL: se a reserva foi feita mas startRoomStreaming falhou, refunda
    if (auth.type === "free" && auth.reservedMin > 0) {
      try {
        const db = getDb();
        if (db) {
          await db.collection("streaming_usage").doc(`${email}_${todayKey()}`).update({
            minutesUsed: admin.firestore.FieldValue.increment(-auth.reservedMin)
          });
        }
      } catch (_) {}
    }
    if (err.message === "STREAM_JA_ATIVO") return sendError(res, 409, "STREAM_JA_ATIVO");
    if (err.message?.startsWith("PLATAFORMA_NAO_SUPORTADA")) return sendError(res, 400, err.message);
    if (err.message?.startsWith("LAYOUT_NAO_SUPORTADO"))     return sendError(res, 400, err.message);
    if (err.message?.startsWith("STREAM_KEY_"))              return sendError(res, 400, err.message);
    if (err.message?.includes("room does not exist")) {
      return sendError(res, 409, "SALA_LIVEKIT_VAZIA", { hint: "Abra Câmera ou Mic antes de iniciar POV/Grid (Cards funciona sem)" });
    }
    logError("streaming_start_error", err, { roomId });
    return sendError(res, 500, "ERRO_INICIAR_STREAMING");
  }
}));

// GET /streaming/usage/:email — quanto da quota free tier de hoje já foi usada
router.get("/streaming/usage/:email", readLimiter, requireFirebaseAuth, requireEmailMatchesToken, asyncHandler(async (req, res) => {
  const email = normalizePathEmail(req);
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");
  const db = getDb();
  if (!db) return res.json({ ok: true, dailyLimitMin: FREE_TIER_DAILY_LIMIT_MIN, usedMin: 0, remainingMin: FREE_TIER_DAILY_LIMIT_MIN });
  try {
    const doc = await db.collection("streaming_usage").doc(`${email}_${todayKey()}`).get();
    const usedMin = doc.exists ? Number(doc.data().minutesUsed || 0) : 0;
    return res.json({
      ok: true,
      dailyLimitMin: FREE_TIER_DAILY_LIMIT_MIN,
      usedMin,
      remainingMin: Math.max(0, FREE_TIER_DAILY_LIMIT_MIN - usedMin)
    });
  } catch (err) {
    logError("streaming_usage_check_error", err);
    return res.json({ ok: true, dailyLimitMin: FREE_TIER_DAILY_LIMIT_MIN, usedMin: 0, remainingMin: FREE_TIER_DAILY_LIMIT_MIN });
  }
}));

// POST /streaming/stop
// body: { roomId }
// Security #4: exige Firebase Bearer; só o dono do stream (mesmo email) pode parar.
router.post("/streaming/stop", requireFirebaseAuth, asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  const activeJob = activeStreams.get(roomId);
  if (!activeJob) return sendError(res, 404, "STREAM_NAO_ENCONTRADO");

  const callerEmail = String(req.firebaseUser?.email || "").toLowerCase();
  // Sec #B5: comparação estrita rejeita também email=undefined no job, que
  // pode ocorrer se o /start crashou entre o Map.set e o set de email
  // (in_progress race com o cleanup loop). Sem isso, qualquer caller
  // autenticado conseguiria parar streams órfãos de outros usuários.
  if (activeJob.email !== callerEmail) {
    return sendError(res, 403, "NAO_E_SEU_STREAM");
  }

  try {
    const job = await stopRoomStreaming(roomId);
    const durationMs = job ? (job.stoppedAt - job.startedAt) : 0;

    const email = activeJob.email;
    const minutes = Math.ceil(durationMs / 60000);

    if (email) {
      const db = getDb();
      if (db) {
        // Security #5: refunda o tempo não usado da reserva (debitada upfront no /start)
        if (activeJob.authType === "free") {
          const reservedMin = Number(activeJob.reservedMin || 0);
          const delta = minutes - reservedMin; // se positivo, debita mais; se negativo, refunda
          if (delta !== 0) {
            try {
              await db.collection("streaming_usage").doc(`${email}_${todayKey()}`).update({
                minutesUsed: admin.firestore.FieldValue.increment(delta),
                lastSessionEnd: Date.now()
              });
            } catch (err) {
              logError("streaming_usage_settle_error", err, { email, reservedMin, actualMin: minutes });
            }
          }
        }

        // Phase 4: agrega stats por usuário (todos os tiers, prestige incluso)
        try {
          const statsRef = db.collection("streaming_stats").doc(email);
          const cur = await statsRef.get();
          const prev = cur.exists ? cur.data() : {};
          await statsRef.set({
            email,
            totalMinutes: Number(prev.totalMinutes || 0) + minutes,
            totalSessions: Number(prev.totalSessions || 0) + 1,
            firstStreamAt: prev.firstStreamAt || (job?.startedAt || Date.now()),
            lastStreamAt: Date.now()
          }, { merge: true });
        } catch (err) {
          logError("streaming_stats_update_error", err, { email });
        }

        // Phase 4: histórico individual de sessão
        try {
          await db.collection("streaming_history").doc(email).collection("sessions").add({
            startedAt: job?.startedAt || Date.now() - durationMs,
            endedAt:   Date.now(),
            durationMs,
            durationMin: minutes,
            platforms: (activeJob.platforms || []).map(p => p.name),
            layout:    activeJob.layout || "cards",
            authType:  activeJob.authType || "unknown"
          });
        } catch (err) {
          logError("streaming_history_save_error", err, { email });
        }
      }
    }

    // #B4: se o stopEgress falhou, devolve 502 mesmo após registrar
    // duração/quota — cliente precisa saber pra tentar de novo ou
    // mostrar mensagem de erro. O Map já foi limpo (ver webrtc.js),
    // mas o egress real pode estar pendurado na LiveKit.
    if (job && job.egressStopOk === false) {
      return sendError(res, 502, "EGRESS_STOP_FALHOU", {
        hint: "O streaming foi marcado como encerrado, mas o egress da LiveKit pode estar consumindo minutos. Tente parar de novo em alguns segundos."
      });
    }
    return res.json({ ok: true, durationMs, minutes });
  } catch (err) {
    logError("streaming_stop_error", err, { roomId });
    return sendError(res, 500, "ERRO_PARAR_STREAMING");
  }
}));

// GET /streaming/stats/:email — agregado total do usuário (Phase 4)
router.get("/streaming/stats/:email", readLimiter, requireFirebaseAuth, requireEmailMatchesToken, asyncHandler(async (req, res) => {
  const email = normalizePathEmail(req);
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");
  const db = getDb();
  if (!db) return res.json({ ok: true, totalMinutes: 0, totalSessions: 0 });
  try {
    const doc = await db.collection("streaming_stats").doc(email).get();
    if (!doc.exists) return res.json({ ok: true, totalMinutes: 0, totalSessions: 0 });
    const d = doc.data();
    return res.json({
      ok: true,
      totalMinutes:  Number(d.totalMinutes || 0),
      totalSessions: Number(d.totalSessions || 0),
      firstStreamAt: d.firstStreamAt || null,
      lastStreamAt:  d.lastStreamAt  || null
    });
  } catch (err) {
    logError("streaming_stats_fetch_error", err);
    return res.json({ ok: true, totalMinutes: 0, totalSessions: 0 });
  }
}));

// GET /streaming/history/:email?limit=20 — últimas sessões (Phase 4)
router.get("/streaming/history/:email", readLimiter, requireFirebaseAuth, requireEmailMatchesToken, asyncHandler(async (req, res) => {
  const email = normalizePathEmail(req);
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");
  const db = getDb();
  if (!db) return res.json({ ok: true, sessions: [] });
  try {
    const snap = await db
      .collection("streaming_history").doc(email).collection("sessions")
      .orderBy("endedAt", "desc")
      .limit(limit)
      .get();
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, sessions });
  } catch (err) {
    logError("streaming_history_fetch_error", err);
    return res.json({ ok: true, sessions: [] });
  }
}));

// GET /streaming/status/:roomId
router.get("/streaming/status/:roomId", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.params.roomId);
    const active = activeStreams.get(roomId);

    if (active) {
      return res.json({
        ok: true,
        active: true,
        egressId:  active.egressId,
        platforms: active.platforms,
        layout:    active.layout,
        startedAt: active.startedAt,
        durationMs: Date.now() - active.startedAt
      });
    }
    return res.json({ ok: true, active: false });
  } catch (err) {
    logError("streaming_status_error", err);
    return sendError(res, 500, "ERRO_STATUS_STREAMING");
  }
});

module.exports = router;
