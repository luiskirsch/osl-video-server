'use strict';

/**
 * routes/hub.js — Hub "Entre Sessões" (v2)
 *
 * GET  /hub        — home screen do jogo (auth required)
 * POST /hub/touch  — atualiza presença (auth required)
 *
 * Retorna em um único request:
 *   daily       — ritual do dia
 *   world       — world state (communityProgress, missão, conteúdo desbloqueado)
 *   friends     — top 10 conexões com status online em tempo real
 *   myGroups    — salas com agenda recorrente criadas pelo usuário
 *   discoveries — rumores disponíveis + teasers
 *   lastSession — última sala jogada (roomId, roomName, sessionId, sessionAt)
 *   unread      — badge de notificações
 */

const express = require('express');
const admin   = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const socialGraph   = require('../services/socialGraph');
const liveService   = require('../services/liveService');
const worldState    = require('../services/worldState');
const notifications = require('../services/notifications');
const presence      = require('../services/presence');
const discoveries   = require('../services/discoveries');
const reputation    = require('../services/reputation');

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

  // Atualiza presença de forma assíncrona
  presence.touch(uid).catch(() => {});

  // Tudo em paralelo — cada item falha independentemente
  const [dailyRes, worldRes, connectionsRes, unreadRes, repRes, userDocRes] = await Promise.allSettled([
    liveService.getDailyRitual(),
    worldState.getWorldState(),
    socialGraph.getConnections(uid, 20),
    notifications.getUnreadCount(uid),
    reputation.getReputation(uid),
    _getUserDoc(uid),
  ]);

  const daily       = dailyRes.status       === 'fulfilled' ? dailyRes.value       : null;
  const world       = worldRes.status       === 'fulfilled' ? worldRes.value       : null;
  const connections = connectionsRes.status === 'fulfilled' ? connectionsRes.value : [];
  const unread      = unreadRes.status      === 'fulfilled' ? unreadRes.value      : 0;
  const rep         = repRes.status         === 'fulfilled' ? repRes.value         : null;
  const userDoc     = userDocRes.status     === 'fulfilled' ? userDocRes.value     : null;

  // Presença dos amigos
  const friendUids  = (connections || []).map(c => c.uid);
  const presenceMap = friendUids.length
    ? await presence.batchCheck(friendUids).catch(() => ({}))
    : {};

  const friends = (connections || []).map(c => ({
    uid:          c.uid,
    displayName:  presenceMap[c.uid]?.displayName  || null,
    photoURL:     presenceMap[c.uid]?.photoURL      || null,
    online:       presenceMap[c.uid]?.online         ?? false,
    lastSeenMs:   presenceMap[c.uid]?.lastSeenMs    ?? c.lastPlayedAt,
    lastActivity: presenceMap[c.uid]?.lastActivity  || null,
    sessionCount: c.sessionCount,
    lastPlayedAt: c.lastPlayedAt,
  })).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.sessionCount - a.sessionCount;
  }).slice(0, 10);

  // Grupos com agenda recorrente criados pelo usuário
  const myGroups = await _getMyGroups(uid).catch(() => []);

  // Última sessão jogada (salvo pelo reputation service no session.ended)
  const lastSession = await _resolveLastSession(userDoc, rep).catch(() => null);

  // Rumores disponíveis
  const discoveryResult = await discoveries.getDiscoveries(uid, {
    worldProgress:    world?.communityProgress || 0,
    userSessionCount: rep?.totalSessions       || 0,
  }).catch(() => ({ available: [], teasers: [], totalDiscoveries: 0 }));

  return res.json({
    ok:           true,
    uid,
    daily,
    world,
    friends,
    myGroups,
    lastSession,
    discoveries:  discoveryResult,
    unread:       unread ?? 0,
  });
}));

// ── POST /hub/touch ───────────────────────────────────────────────────────────

router.post('/hub/touch', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');
  await presence.touch(uid);
  return res.json({ ok: true });
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _getUserDoc(uid) {
  const db = require('../services/firestore').db;
  if (!db) return null;
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function _getMyGroups(uid) {
  const db = require('../services/firestore').db;
  if (!db) return [];

  const snap = await db.collection('recurring_schedules')
    .where('createdBy', '==', uid)
    .where('active',    '==', true)
    .limit(5)
    .get();

  if (snap.empty) return [];

  const DAY_NAMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  return snap.docs.map(doc => {
    const d = doc.data();
    let localHour = d.utcHour - 3;
    let localDay  = d.dayOfWeek;
    if (localHour < 0) { localHour += 24; localDay = (localDay + 6) % 7; }
    const hh = String(localHour).padStart(2, '0');
    const mm = String(d.utcMinute).padStart(2, '0');
    return {
      roomId:       d.roomId,
      scheduleLabel: `${DAY_NAMES[localDay]} às ${hh}:${mm}`,
      dayOfWeek:    d.dayOfWeek,
      utcHour:      d.utcHour,
      utcMinute:    d.utcMinute,
    };
  });
}

async function _resolveLastSession(userDoc, rep) {
  const lastRoomId   = userDoc?.lastRoomId   || null;
  const lastSessionId = rep?.lastSessionId   || null;
  const lastSessionAt = userDoc?.lastSessionAt?.toMillis?.() ?? null;

  if (!lastRoomId) return null;

  // Busca nome da sala (uma leitura, só se tiver lastRoomId)
  const db = require('../services/firestore').db;
  let roomName = null;
  if (db) {
    const snap = await db.collection('salas').doc(lastRoomId).get().catch(() => null);
    roomName = snap?.exists ? (snap.data().name || null) : null;
  }

  return { roomId: lastRoomId, sessionId: lastSessionId, roomName, sessionAt: lastSessionAt };
}

module.exports = router;
