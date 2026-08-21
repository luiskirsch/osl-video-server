const express = require("express");
const admin   = require("firebase-admin");
const { getDb }             = require("../services/firestore");
const { requireAdmin }      = require("../services/auth");
const { logInfo, logError } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const { aggregateSessions } = require("../services/sessionStats");

const router = express.Router();
const ROOM_STATS_SESSION_LIMIT = 200;
const ROOM_STATS_SCAN_BUFFER = 25;

// GET /analytics/room/:roomId/stats
// Agrega estatísticas das até 200 sessões encerradas mais recentes da sala.
// Auth: Firebase ID token (Bearer).
router.get("/analytics/room/:roomId/stats", asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendError(res, 401, "TOKEN_OBRIGATORIO");
  try { await admin.auth().verifyIdToken(token); } catch (_) {
    return sendError(res, 403, "TOKEN_INVALIDO");
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const snap = await db.collection("salas").doc(roomId)
    .collection("sessions")
    .orderBy("createdAt", "desc")
    .limit(ROOM_STATS_SESSION_LIMIT + ROOM_STATS_SCAN_BUFFER)
    .get();

  const sessionsData = snap.docs
    .map(d => d.data())
    .filter(s => s.status === "ended")
    .slice(0, ROOM_STATS_SESSION_LIMIT);

  const agg = aggregateSessions(sessionsData);

  logInfo("analytics_room_stats", { roomId, totalSessions: sessionsData.length });
  return res.json({ ok: true, stats: { totalSessions: sessionsData.length, ...agg } });
}));

// GET /analytics/global
// Agrega estatísticas de toda a plataforma (admin-only).
// Auth: x-admin-secret header.
router.get("/analytics/global", requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  try {
    const [sessionsSnap, usersSnap] = await Promise.all([
      db.collectionGroup("sessions").where("status", "==", "ended").limit(500).get(),
      db.collection("users").limit(1000).get(),
    ]);

    const sessionsData = sessionsSnap.docs.map(d => d.data());
    const agg          = aggregateSessions(sessionsData);

    const totalUsers         = usersSnap.size;
    const usersWithPurchases = usersSnap.docs.filter(d => (d.data().compras || []).length > 0).length;

    const stats = {
      totalSessions:       sessionsData.length,
      totalUsers,
      usersWithPurchases,
      conversionRate:      totalUsers > 0 ? Math.round((usersWithPurchases / totalUsers) * 100) : 0,
      ...agg,
    };

    logInfo("analytics_global", { totalSessions: sessionsData.length, totalUsers });
    return res.json({ ok: true, stats });
  } catch (e) {
    logError("analytics_global_error", e);
    return sendError(res, 500, "ERRO_ANALYTICS_GLOBAL");
  }
}));

module.exports = router;
