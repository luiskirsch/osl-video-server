const express = require("express");
const admin   = require("firebase-admin");
const { getDb }             = require("../services/firestore");
const { requireAdmin }      = require("../services/auth");
const { logInfo, logError } = require("../logger");
const { asyncHandler, sendError } = require("../utils");

const router = express.Router();

// Agrega summary de um array de session data objects.
function aggregateSessions(sessionsData) {
  let totalCards = 0, totalTimeSec = 0, totalPlayers = 0, totalVotes = 0, totalMissions = 0;
  const emojiTally = {};
  let withSummary = 0;

  for (const s of sessionsData) {
    const sum = s.summary;
    if (!sum) continue;
    withSummary++;
    totalCards    += sum.cardsRevealed     || 0;
    totalTimeSec  += sum.durationSec       || 0;
    totalPlayers  += sum.playerCount       || 0;
    totalVotes    += sum.votesTotal        || 0;
    totalMissions += sum.missionsCompleted || 0;
    for (const [emoji, count] of Object.entries(sum.emojiTally || {})) {
      emojiTally[emoji] = (emojiTally[emoji] || 0) + Number(count);
    }
  }

  const topEmojiEntry = Object.entries(emojiTally).sort((a, b) => b[1] - a[1])[0];
  return {
    totalCardsRevealed: totalCards,
    totalPlayTimeSec:   totalTimeSec,
    avgDurationSec:     withSummary > 0 ? Math.round(totalTimeSec / withSummary) : 0,
    avgPlayers:         withSummary > 0 ? Math.round((totalPlayers / withSummary) * 10) / 10 : 0,
    totalVotes,
    totalMissions,
    topEmoji:           topEmojiEntry?.[0] || null,
    emojiTally,
  };
}

// GET /analytics/room/:roomId/stats
// Agrega estatísticas de todas as sessões encerradas de uma sala.
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
    .limit(50)
    .get();

  const sessionsData = snap.docs
    .map(d => d.data())
    .filter(s => s.status === "ended");

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
