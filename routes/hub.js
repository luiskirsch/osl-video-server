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
const { getDb: _getFirestoreDb } = require('../services/firestore');
const { FieldValue } = require('firebase-admin/firestore');
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
  const [dailyRes, worldRes, connectionsRes, unreadRes, repRes, userDocRes, eventsRes, seasonRes] = await Promise.allSettled([
    liveService.getDailyRitual(),
    worldState.getWorldState(),
    socialGraph.getConnections(uid, 20),
    notifications.getUnreadCount(uid),
    reputation.getReputation(uid),
    _getUserDoc(uid),
    liveService.getActiveEvents(),
    liveService.getActiveSeason(),
  ]);

  const dailyRaw    = dailyRes.status       === 'fulfilled' ? dailyRes.value       : null;
  const daily       = dailyRaw ? {
    ...dailyRaw,
    question:    dailyRaw.cardText  || dailyRaw.cardTitle || '',
    respondents: dailyRaw.completionCount ?? 0,
  } : null;
  const world       = worldRes.status       === 'fulfilled' ? worldRes.value       : null;
  const connections = connectionsRes.status === 'fulfilled' ? connectionsRes.value : [];
  const unread      = unreadRes.status      === 'fulfilled' ? unreadRes.value      : 0;
  const rep         = repRes.status         === 'fulfilled' ? repRes.value         : null;
  const userDoc     = userDocRes.status     === 'fulfilled' ? userDocRes.value     : null;
  const events      = eventsRes.status      === 'fulfilled' ? (eventsRes.value  || []) : [];
  const season      = seasonRes.status      === 'fulfilled' ? seasonRes.value      : null;

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

  // Fragmento pendente (já lido no userDoc — zero custo extra)
  let fragment = null;
  if (userDoc?.pendingFragment) {
    const pf        = userDoc.pendingFragment;
    const expiresAt = pf.expiresAt instanceof Date
      ? pf.expiresAt
      : pf.expiresAt?.toDate?.() ?? null;
    if (expiresAt && expiresAt > new Date()) {
      fragment = { card: pf.card, expiresAt: expiresAt.getTime() };
    }
  }

  return res.json({
    ok:           true,
    uid,
    daily,
    season,
    events,
    world,
    friends,
    myGroups,
    lastSession,
    discoveries:  discoveryResult,
    fragment,
    unread:       unread ?? 0,
  });
}));

// ── POST /daily/complete ──────────────────────────────────────────────────────

router.post('/daily/complete', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const daily = await liveService.getDailyRitual().catch(() => null);
  if (!daily) return sendError(res, 404, 'RITUAL_NAO_ENCONTRADO');

  const db  = _getFirestoreDb();
  const ref = db.collection('daily_ritual').doc(daily.date);

  await ref.update({ completionCount: FieldValue.increment(1) }).catch(() => {});

  const snap     = await ref.get().catch(() => null);
  const newCount = snap?.data()?.completionCount ?? (daily.completionCount + 1);

  return res.json({ ok: true, xp: daily.bonusXp || 35, completionCount: newCount });
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
  const db = require('../services/firestore').getDb();
  if (!db) return null;
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function _getMyGroups(uid) {
  const db = require('../services/firestore').getDb();
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
  const lastRoomId    = userDoc?.lastRoomId  || null;
  const lastSessionId = rep?.lastSessionId   || null;
  const lastSessionAt = userDoc?.lastSessionAt?.toMillis?.() ?? null;

  if (!lastRoomId) return null;

  const db = require('../services/firestore').getDb();
  if (!db) return { roomId: lastRoomId, sessionId: lastSessionId, roomName: null, sessionAt: lastSessionAt, dna: null };

  // Lê sala + DNA em paralelo (uma round-trip cada)
  const [salaSnap, dnaSnap] = await Promise.all([
    db.collection('salas').doc(lastRoomId).get().catch(() => null),
    db.collection('salas').doc(lastRoomId).collection('meta').doc('dna').get().catch(() => null),
  ]);

  const roomName = salaSnap?.exists ? (salaSnap.data().name || null) : null;

  let dna = null;
  if (dnaSnap?.exists) {
    const d = dnaSnap.data();
    // Resume o DNA em campos legíveis para o cliente renderizar
    const cardTypeCounts = d.cardTypeCounts || {};
    const totalCards     = Object.values(cardTypeCounts).reduce((s, v) => s + v, 0) || 1;
    const dominantType   = Object.entries(cardTypeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const dominantPct    = dominantType ? Math.round(cardTypeCounts[dominantType] / totalCards * 100) : null;

    dna = {
      sessionCount:     d.sessionCount     || 0,
      avgDurationSec:   d.avgDurationSec   || 0,
      dominantType,
      dominantPct,
      topCards:         (d.topCards        || []).slice(0, 3),
      topReactors:      (d.topReactors     || []).slice(0, 3),
    };
  }

  return { roomId: lastRoomId, sessionId: lastSessionId, roomName, sessionAt: lastSessionAt, dna };
}

module.exports = router;
