const express = require("express");
const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const { activeStreams, pagamentosAprovados } = require("../game/state");
const { normalizeRoomId } = require("../game/rooms");
const { startRoomStreaming, stopRoomStreaming, egressClient } = require("../video/webrtc");
const { getDb } = require("../services/firestore");

const router = express.Router();

// GET /streaming/pass/:email — verifica se o email tem Stream Pass mensal ativo (ou Prestige)
router.get("/streaming/pass/:email", asyncHandler(async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");

  const db = getDb();
  if (!db) return res.json({ ok: true, active: false });

  try {
    // Prestige: usuários nível 50+ têm streaming incluído permanentemente
    const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    if (!usersSnap.empty && usersSnap.docs[0].data().prestige === true) {
      return res.json({ ok: true, active: true, expiresAt: null, type: "prestige" });
    }

    const doc = await db.collection("streaming_passes").doc(email).get();
    if (!doc.exists) return res.json({ ok: true, active: false });

    const pass = doc.data();
    const active = pass.expiresAt > Date.now();
    return res.json({ ok: true, active, expiresAt: pass.expiresAt || null, type: pass.type || "streaming-mensal" });
  } catch (err) {
    logError("streaming_pass_check_error", err);
    return res.json({ ok: true, active: false });
  }
}));

// Quota free tier: 60 min por email por dia (UTC)
const FREE_TIER_DAILY_LIMIT_MIN = 60;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function checkAuthAndQuota(email) {
  // Retorna { allowed, type, remainingMin?, reason? }
  if (!email) return { allowed: false, reason: "EMAIL_OBRIGATORIO" };
  const db = getDb();
  if (!db) return { allowed: true, type: "no-firestore" }; // fallback se Firestore offline

  try {
    // 1. Prestige
    const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    if (!usersSnap.empty && usersSnap.docs[0].data().prestige === true) {
      return { allowed: true, type: "prestige" };
    }

    // 2. Pass mensal ativo
    const passDoc = await db.collection("streaming_passes").doc(email).get();
    if (passDoc.exists && passDoc.data().expiresAt > Date.now()) {
      return { allowed: true, type: "pass", expiresAt: passDoc.data().expiresAt };
    }

    // 3. Free tier: verifica uso do dia
    const usageDoc = await db.collection("streaming_usage").doc(`${email}_${todayKey()}`).get();
    const usedMin = usageDoc.exists ? Number(usageDoc.data().minutesUsed || 0) : 0;
    const remainingMin = Math.max(0, FREE_TIER_DAILY_LIMIT_MIN - usedMin);
    if (remainingMin <= 0) {
      return { allowed: false, reason: "QUOTA_DIARIA_ESGOTADA", usedMin, remainingMin: 0 };
    }
    return { allowed: true, type: "free", remainingMin };
  } catch (err) {
    logError("streaming_auth_check_error", err);
    return { allowed: true, type: "auth-error-fallback" }; // não bloqueia em caso de erro do DB
  }
}

// POST /streaming/start
// body: {
//   roomId,
//   email,                                      (obrigatório pra gating)
//   platforms: [{ name: "youtube"|"twitch"|"facebook"|"kick"|"tiktok"|"custom", streamKey }],
//   layoutId: "cards" | "pov-host" | "grid"     (opcional, default "cards")
// }
router.post("/streaming/start", asyncHandler(async (req, res) => {
  const roomId    = normalizeRoomId(req.body?.roomId);
  const email     = String(req.body?.email || "").trim().toLowerCase();
  const platforms = req.body?.platforms;
  const layoutId  = String(req.body?.layoutId || "cards").trim();

  if (!roomId)                            return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!email)                             return sendError(res, 400, "EMAIL_OBRIGATORIO");
  if (!Array.isArray(platforms) || !platforms.length) return sendError(res, 400, "PLATAFORMAS_OBRIGATORIAS");
  if (!egressClient)                      return sendError(res, 503, "EGRESS_NAO_CONFIGURADO");

  for (const p of platforms) {
    if (!p?.name)      return sendError(res, 400, "PLATAFORMA_SEM_NOME");
    if (!p?.streamKey) return sendError(res, 400, "STREAM_KEY_OBRIGATORIA");
  }

  // Gate: prestige / pass ativo / free tier com quota
  const auth = await checkAuthAndQuota(email);
  if (!auth.allowed) {
    return sendError(res, 402, auth.reason || "ACESSO_NEGADO", {
      usedMin: auth.usedMin,
      remainingMin: auth.remainingMin,
      hint: "Compre o Stream Pass mensal pra streamar sem limite, ou aguarde 24h pra resetar a quota gratuita."
    });
  }

  try {
    const job = await startRoomStreaming(roomId, platforms, layoutId);
    job.email   = email;
    job.authType = auth.type;
    activeStreams.set(roomId, job); // sobrescreve com email pra debit no stop
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
    if (err.message === "STREAM_JA_ATIVO") return sendError(res, 409, "STREAM_JA_ATIVO");
    if (err.message?.startsWith("PLATAFORMA_NAO_SUPORTADA")) return sendError(res, 400, err.message);
    if (err.message?.startsWith("LAYOUT_NAO_SUPORTADO"))     return sendError(res, 400, err.message);
    if (err.message?.includes("room does not exist")) {
      return sendError(res, 409, "SALA_LIVEKIT_VAZIA", { hint: "Abra Câmera ou Mic antes de iniciar POV/Grid (Cards funciona sem)" });
    }
    logError("streaming_start_error", err, { roomId });
    return sendError(res, 500, "ERRO_INICIAR_STREAMING");
  }
}));

// GET /streaming/usage/:email — quanto da quota free tier de hoje já foi usada
router.get("/streaming/usage/:email", asyncHandler(async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
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
router.post("/streaming/stop", asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  const activeJob = activeStreams.get(roomId);
  if (!activeJob) return sendError(res, 404, "STREAM_NAO_ENCONTRADO");

  try {
    const job = await stopRoomStreaming(roomId);
    const durationMs = job ? (job.stoppedAt - job.startedAt) : 0;

    const email = activeJob.email;
    const minutes = Math.ceil(durationMs / 60000);

    if (email) {
      const db = getDb();
      if (db) {
        // Debita minutos da quota free tier (apenas se o auth foi "free")
        if (activeJob.authType === "free") {
          const docRef = db.collection("streaming_usage").doc(`${email}_${todayKey()}`);
          try {
            const cur = await docRef.get();
            const usedMin = cur.exists ? Number(cur.data().minutesUsed || 0) : 0;
            await docRef.set({
              email, date: todayKey(),
              minutesUsed: usedMin + minutes,
              lastSessionEnd: Date.now()
            }, { merge: true });
          } catch (err) {
            logError("streaming_usage_debit_error", err, { email, minutes });
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

    return res.json({ ok: true, durationMs, minutes });
  } catch (err) {
    logError("streaming_stop_error", err, { roomId });
    return sendError(res, 500, "ERRO_PARAR_STREAMING");
  }
}));

// GET /streaming/stats/:email — agregado total do usuário (Phase 4)
router.get("/streaming/stats/:email", asyncHandler(async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
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
router.get("/streaming/history/:email", asyncHandler(async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
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
