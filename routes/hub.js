'use strict';

/**
 * routes/hub.js — Hub "Entre Sessões" (inspirado no mundo persistente de GTA)
 *
 * GET  /hub        — dados agregados para a home screen do jogo (auth required)
 * POST /hub/touch  — atualiza presença (auth required, sem body)
 *
 * Retorna em um único request:
 *   daily   — ritual do dia (card, completionCount, dailyParticipants)
 *   world   — world state (communityProgress, currentMission, unlockedContent)
 *   friends — top 10 conexões do social graph com status online em tempo real
 *   unread  — contagem de notificações não lidas
 */

const express = require('express');
const admin   = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const socialGraph   = require('../services/socialGraph');
const liveService   = require('../services/liveService');
const worldState    = require('../services/worldState');
const notifications = require('../services/notifications');
const presence      = require('../services/presence');

const router = express.Router();

async function getUid(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
             || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (_) { return null; }
}

// ── GET /hub ─────────────────────────────────────────────────────────────────

router.get('/hub', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  // Atualiza presença de forma assíncrona — não bloqueia a resposta
  presence.touch(uid).catch(() => {});

  // Paralleliza tudo
  const [dailyRes, worldRes, connectionsRes, unreadRes] = await Promise.allSettled([
    liveService.getDailyRitual(),
    worldState.getWorldState(),
    socialGraph.getConnections(uid, 20),
    notifications.getUnreadCount(uid),
  ]);

  const daily       = dailyRes.status       === 'fulfilled' ? dailyRes.value       : null;
  const world       = worldRes.status       === 'fulfilled' ? worldRes.value       : null;
  const connections = connectionsRes.status === 'fulfilled' ? connectionsRes.value : [];
  const unread      = unreadRes.status      === 'fulfilled' ? unreadRes.value      : 0;

  // Verifica presença dos amigos
  const friendUids  = (connections || []).map(c => c.uid);
  const presenceMap = friendUids.length
    ? await presence.batchCheck(friendUids).catch(() => ({}))
    : {};

  const friends = (connections || []).map(c => ({
    uid:          c.uid,
    displayName:  presenceMap[c.uid]?.displayName || null,
    photoURL:     presenceMap[c.uid]?.photoURL    || null,
    online:       presenceMap[c.uid]?.online       ?? false,
    lastSeenMs:   presenceMap[c.uid]?.lastSeenMs  ?? c.lastPlayedAt,
    sessionCount: c.sessionCount,
    lastPlayedAt: c.lastPlayedAt,
  }));

  // Online primeiro, depois por número de sessões juntos
  friends.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.sessionCount - a.sessionCount;
  });

  return res.json({
    ok:      true,
    uid,
    daily:   daily ?? null,
    world:   world ?? null,
    friends: friends.slice(0, 10),
    unread:  unread ?? 0,
  });
}));

// ── POST /hub/touch ───────────────────────────────────────────────────────────
// Endpoint leve para o cliente atualizar presença periodicamente (a cada ~3 min)

router.post('/hub/touch', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');
  await presence.touch(uid);
  return res.json({ ok: true });
}));

module.exports = router;
