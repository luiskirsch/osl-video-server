'use strict';

/**
 * Hub "Entre Sessões".
 *
 * Esta rota é o agregador autenticado do estado da conta. A persistência
 * canônica fica em users/{firebaseUid}; fontes legadas são apenas fallbacks de
 * leitura durante a migração.
 */

const express = require('express');
const admin = require('firebase-admin');
const { getDb: _getFirestoreDb } = require('../services/firestore');
const { asyncHandler, sendError } = require('../utils');
const socialGraph = require('../services/socialGraph');
const liveService = require('../services/liveService');
const worldState = require('../services/worldState');
const notifications = require('../services/notifications');
const presence = require('../services/presence');
const discoveries = require('../services/discoveries');
const reputation = require('../services/reputation');
const accountState = require('../services/accountState');
const eventBus = require('../services/events');

const router = express.Router();

async function getClaims(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_) {
    return null;
  }
}

// GET /game/me — contrato canônico reutilizável por qualquer tela.
router.get('/game/me', asyncHandler(async (req, res) => {
  const claims = await getClaims(req);
  const uid = claims?.uid;
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const db = _getFirestoreDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const [userDoc, rep] = await Promise.all([
    _getUserDoc(uid),
    reputation.getReputation(uid).catch(() => null),
  ]);
  const lastSession = await _resolveLastSession(userDoc, rep).catch(() => null);
  const account = await accountState.ensureAccountSnapshot({
    db,
    uid,
    claims,
    userData: userDoc,
    lastSession,
  });

  return res.json({ ok: true, account });
}));

// GET /hub
router.get('/hub', asyncHandler(async (req, res) => {
  const claims = await getClaims(req);
  const uid = claims?.uid;
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const db = _getFirestoreDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  // Presença nunca deve tornar o Hub indisponível.
  presence.touch(uid).catch(() => {});

  // Fontes independentes falham isoladamente: um painel opcional não derruba o Hub.
  const results = await Promise.allSettled([
    liveService.getDailyRitual(),
    worldState.getWorldState(),
    socialGraph.getConnections(uid, 20),
    notifications.getUnreadCount(uid),
    reputation.getReputation(uid),
    _getUserDoc(uid),
    liveService.getActiveEvents(),
    liveService.getActiveSeason(),
    notifications.getNotifications(uid, { limit: 5 }),
  ]);

  const value = (index, fallback) => results[index].status === 'fulfilled'
    ? results[index].value
    : fallback;

  const dailyRaw = value(0, null);
  const world = value(1, null);
  const connections = value(2, []) || [];
  const unread = value(3, 0) ?? 0;
  const rep = value(4, null);
  const userDoc = value(5, null) || {};
  const events = value(6, []) || [];
  const season = value(7, null);
  const recentNotifications = value(8, []) || [];

  // A conta canônica não é um painel opcional. Se essa leitura falhar, não
  // fabricamos `{}` nem escrevemos defaults sobre um perfil possivelmente
  // existente; a requisição falha e pode ser repetida com segurança.
  if (results[5].status !== 'fulfilled') throw results[5].reason;

  const [friends, myGroups, lastSession, discoveryResult, completedByUser] = await Promise.all([
    _hydrateFriends(uid, userDoc, connections).catch(() => []),
    _getMyGroups(uid).catch(() => []),
    _resolveLastSession(userDoc, rep).catch(() => null),
    discoveries.getDiscoveries(uid, {
      worldProgress: world?.communityProgress || 0,
      userSessionCount: rep?.totalSessions || 0,
    }).catch(() => ({ available: [], teasers: [], totalDiscoveries: 0 })),
    _hasCompletedDaily(uid, dailyRaw?.date).catch(() => false),
  ]);

  const daily = dailyRaw ? {
    ...dailyRaw,
    question: dailyRaw.cardText || dailyRaw.cardTitle || '',
    respondents: dailyRaw.completionCount ?? 0,
    completedByUser,
  } : null;

  const account = await accountState.ensureAccountSnapshot({
    db,
    uid,
    claims,
    userData: results[5].value,
    lastSession,
  });

  // Fragmento pendente já está no documento canônico do usuário.
  let fragment = null;
  if (userDoc.pendingFragment) {
    const pending = userDoc.pendingFragment;
    const expiresAt = pending.expiresAt instanceof Date
      ? pending.expiresAt
      : pending.expiresAt?.toDate?.() ?? null;
    if (expiresAt && expiresAt > new Date()) {
      fragment = { card: pending.card, expiresAt: expiresAt.getTime() };
    }
  }

  return res.json({
    ok: true,
    uid,
    account,
    // Aliases de transição para clientes que ainda não adotaram AccountSnapshot.
    xp: account.progression.xp,
    level: account.progression.level,
    coins: account.wallet.coins,
    daily,
    season,
    events,
    world,
    friends,
    myGroups,
    lastSession,
    discoveries: discoveryResult,
    fragment,
    notifications: recentNotifications,
    unread,
  });
}));

// POST /daily/complete
router.post('/daily/complete', asyncHandler(async (req, res) => {
  const claims = await getClaims(req);
  const uid = claims?.uid;
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const daily = await liveService.getDailyRitual().catch(() => null);
  if (!daily) return sendError(res, 404, 'RITUAL_NAO_ENCONTRADO');

  const db = _getFirestoreDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const completion = await accountState.completeDailyRitual({ db, uid, daily });

  // Efeitos são publicados somente após o commit e somente uma vez.
  if (!completion.alreadyCompleted) {
    liveService.invalidate('daily');
    await eventBus.emitAsync('live.daily_ritual_completed', {
      roomId: null,
      date: daily.date,
      cardTitle: daily.cardTitle || null,
      authedUids: [uid],
      playerCount: 1,
      source: 'hub',
    });
  }

  const [userDoc, rep] = await Promise.all([
    _getUserDoc(uid),
    reputation.getReputation(uid).catch(() => null),
  ]);
  const lastSession = await _resolveLastSession(userDoc, rep).catch(() => null);
  const account = await accountState.ensureAccountSnapshot({
    db,
    uid,
    claims,
    userData: userDoc,
    lastSession,
  });

  return res.json({
    ok: true,
    alreadyCompleted: completion.alreadyCompleted,
    xpAwarded: completion.xpAwarded,
    // Alias legado; ao repetir a chamada, agora retorna corretamente zero.
    xp: completion.xpAwarded,
    completionCount: completion.completionCount,
    completedAt: completion.completedAt,
    account,
  });
}));

// POST /hub/touch
router.post('/hub/touch', asyncHandler(async (req, res) => {
  const claims = await getClaims(req);
  const uid = claims?.uid;
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');
  await presence.touch(uid);
  return res.json({ ok: true });
}));

async function _getUserDoc(uid) {
  const db = _getFirestoreDb();
  if (!db) return null;
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function _hasCompletedDaily(uid, date) {
  if (!uid || !date) return false;
  const db = _getFirestoreDb();
  if (!db) return false;
  const snap = await db.collection('daily_ritual').doc(String(date))
    .collection('completions').doc(uid).get();
  return snap.exists;
}

/**
 * União de amigos declarados e pessoas encontradas em sessões. Uma amizade
 * explícita continua visível mesmo antes de a dupla concluir uma sessão junta.
 */
async function _hydrateFriends(uid, userDoc, connections) {
  const db = _getFirestoreDb();
  if (!db) return [];

  const explicit = new Set(
    (Array.isArray(userDoc?.friends) ? userDoc.friends : [])
      .filter(friendUid => typeof friendUid === 'string' && friendUid && friendUid !== uid),
  );
  const connectionMap = new Map(
    (Array.isArray(connections) ? connections : [])
      .filter(connection => connection?.uid && connection.uid !== uid)
      .map(connection => [connection.uid, connection]),
  );
  const friendUids = Array.from(new Set([
    ...explicit,
    ...connectionMap.keys(),
  ])).slice(0, 30);

  if (!friendUids.length) return [];

  const userRefs = friendUids.map(friendUid => db.collection('users').doc(friendUid));
  const legacyRefs = friendUids.map(friendUid => db.collection('user_profiles').doc(friendUid));
  const [presenceMap, userSnaps, legacySnaps] = await Promise.all([
    presence.batchCheck(friendUids).catch(() => ({})),
    db.getAll(...userRefs).catch(() => []),
    db.getAll(...legacyRefs).catch(() => []),
  ]);

  const usersByUid = new Map(userSnaps.map(snap => [snap.id, snap.exists ? snap.data() : {}]));
  const legacyByUid = new Map(legacySnaps.map(snap => [snap.id, snap.exists ? snap.data() : {}]));

  return friendUids.map(friendUid => {
    const connection = connectionMap.get(friendUid) || {};
    const friend = usersByUid.get(friendUid) || {};
    const legacy = legacyByUid.get(friendUid) || {};
    const friendPresence = presenceMap[friendUid] || {};
    const avatar = accountState.resolveAvatar(friend, legacy, {});

    return {
      uid: friendUid,
      displayName: friend.displayName || friend.name || friend.username
        || legacy.displayName || legacy.name || friendPresence.displayName || null,
      username: friend.username || legacy.username || null,
      avatar,
      // Aliases legados usados pelo renderer atual do Hub.
      photoURL: avatar.url,
      avatarPhotoUrl: avatar.url,
      avatarEmoji: avatar.emoji,
      avatarColor: avatar.color,
      online: friendPresence.online ?? false,
      lastSeenMs: friendPresence.lastSeenMs ?? connection.lastPlayedAt ?? null,
      lastActivity: friendPresence.lastActivity || null,
      sessionCount: Number(connection.sessionCount) || 0,
      lastPlayedAt: connection.lastPlayedAt ?? null,
      isFriend: explicit.has(friendUid),
    };
  }).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.isFriend !== b.isFriend) return a.isFriend ? -1 : 1;
    if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount;
    return (b.lastSeenMs || 0) - (a.lastSeenMs || 0);
  }).slice(0, 10);
}

async function _getMyGroups(uid) {
  const db = _getFirestoreDb();
  if (!db) return [];

  const snap = await db.collection('recurring_schedules')
    .where('createdBy', '==', uid)
    .where('active', '==', true)
    .limit(5)
    .get();

  if (snap.empty) return [];

  const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return snap.docs.map(doc => {
    const data = doc.data();
    let localHour = data.utcHour - 3;
    let localDay = data.dayOfWeek;
    if (localHour < 0) {
      localHour += 24;
      localDay = (localDay + 6) % 7;
    }
    const hh = String(localHour).padStart(2, '0');
    const mm = String(data.utcMinute).padStart(2, '0');
    return {
      roomId: data.roomId,
      scheduleLabel: `${dayNames[localDay]} às ${hh}:${mm}`,
      dayOfWeek: data.dayOfWeek,
      utcHour: data.utcHour,
      utcMinute: data.utcMinute,
    };
  });
}

async function _resolveLastSession(userDoc, rep) {
  const lastRoomId = userDoc?.lastRoomId || null;
  const lastSessionId = rep?.lastSessionId
    || userDoc?.lastSessionId
    || userDoc?.reputation?.lastSessionId
    || null;
  const fallbackPlayedAt = accountState.timestampMs(userDoc?.lastSessionAt);

  if (!lastRoomId) return null;

  const db = _getFirestoreDb();
  if (!db) {
    return {
      roomId: lastRoomId,
      sessionId: lastSessionId,
      roomName: null,
      playedAt: fallbackPlayedAt,
      sessionAt: fallbackPlayedAt,
      playerCount: 0,
      status: null,
      dna: null,
    };
  }

  const sessionPromise = lastSessionId
    ? db.collection('salas').doc(lastRoomId).collection('sessions').doc(lastSessionId)
      .get().catch(() => null)
    : Promise.resolve(null);

  const [roomSnap, dnaSnap, sessionSnap] = await Promise.all([
    db.collection('salas').doc(lastRoomId).get().catch(() => null),
    db.collection('salas').doc(lastRoomId).collection('meta').doc('dna').get().catch(() => null),
    sessionPromise,
  ]);

  const roomName = roomSnap?.exists ? (roomSnap.data().name || null) : null;
  const session = sessionSnap?.exists ? sessionSnap.data() : {};
  const playedAt = accountState.timestampMs(session.endedAt || session.createdAt)
    ?? fallbackPlayedAt;

  let dna = null;
  if (dnaSnap?.exists) {
    const data = dnaSnap.data();
    const cardTypeCounts = data.cardTypeCounts || {};
    const totalCards = Object.values(cardTypeCounts).reduce((sum, count) => sum + count, 0) || 1;
    const dominantType = Object.entries(cardTypeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    dna = {
      sessionCount: data.sessionCount || 0,
      avgDurationSec: data.avgDurationSec || 0,
      dominantType,
      dominantPct: dominantType
        ? Math.round((cardTypeCounts[dominantType] / totalCards) * 100)
        : null,
      topCards: (data.topCards || []).slice(0, 3),
      topReactors: (data.topReactors || []).slice(0, 3),
    };
  }

  return {
    roomId: lastRoomId,
    sessionId: lastSessionId,
    roomName,
    playedAt,
    // Alias legado mantido para os clientes atuais.
    sessionAt: playedAt,
    playerCount: Array.isArray(session.players) ? session.players.length : 0,
    status: session.status || null,
    dna,
  };
}

module.exports = router;
