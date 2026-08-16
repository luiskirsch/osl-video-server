'use strict';

/**
 * services/reputation.js — Reputação de jogadores
 *
 * Computa e atualiza a reputação de cada jogador autenticado após o fim
 * de uma sessão. Os dados são acumulados incrementalmente em users/{uid}.
 *
 * Fórmula de pontuação por sessão:
 *   +10  participou da sessão
 *   +1   por reação enviada (lido dos eventos)
 *   +5   foi o top reator da sessão
 *   +5   votou ao menos uma vez
 *   +15  completou missão (MISSION_COMPLETED)
 *   +5   sessão longa (durationSec > 1800)
 *
 * Níveis:
 *   0-49    Iniciante
 *   50-149  Participante
 *   150-299 Engajado
 *   300-599 Veterano
 *   600-999 Lendário
 *   1000+   Ícone
 *
 * Armazenamento: users/{uid}.reputation (nested object)
 */

const logger = require('../logger');
const events  = require('./events');

const LEVELS = [
  { min: 1000, label: 'Ícone' },
  { min: 600,  label: 'Lendário' },
  { min: 300,  label: 'Veterano' },
  { min: 150,  label: 'Engajado' },
  { min: 50,   label: 'Participante' },
  { min: 0,    label: 'Iniciante' },
];

function reputationLevel(score) {
  return LEVELS.find(l => score >= l.min)?.label || 'Iniciante';
}

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  events.on('live.daily_ritual_completed', async ({ payload }) => {
    const { authedUids } = payload || {};
    if (!Array.isArray(authedUids) || !authedUids.length) return;

    const admin = require('firebase-admin');
    const db    = getDb();
    if (!db) return;

    await Promise.all(authedUids.map(uid =>
      db.collection('users').doc(uid).update({
        'reputation.dailyRitualsCompleted': admin.firestore.FieldValue.increment(1),
      }).catch(() => {})
    ));
  });

  events.on('session.ended', async ({ payload }) => {
    const { roomId, sessionId, summary, players } = payload || {};
    if (!roomId || !sessionId || !summary || !Array.isArray(players)) return;

    const authedPlayers = players.filter(p => p.userId);
    if (!authedPlayers.length) return;

    await settleSessionAccounts(sessionId, roomId, summary, authedPlayers).catch(err =>
      logger.error({ err, roomId, sessionId }, 'reputation_update_failed')
    );
  });

  logger.info({}, 'reputation_initialized');
}

// ── Computação ────────────────────────────────────────────────────────────────

async function settleSessionAccounts(sessionId, roomId, summary, players) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  // Um UID só entra uma vez no settlement, mesmo se aparecer duplicado no
  // snapshot de participantes por causa de uma reconexão.
  const uniquePlayers = Array.from(new Map(
    (players || [])
      .filter(player => player?.userId)
      .map(player => [String(player.userId), player])
  ).values());
  if (!uniquePlayers.length) return { ok: true, alreadySettled: true, awards: [] };

  // Lê eventos da sessão para extrair reações por jogador
  const sessRef    = db.collection('salas').doc(roomId).collection('sessions').doc(sessionId);
  const eventsSnap = await sessRef.collection('events').get();

  const reactionsByUid    = {};   // uid → count
  const pressureByUid     = {};   // uid → count
  const votedUids         = new Set();
  const missionsUids      = new Set();

  for (const doc of (eventsSnap?.docs || [])) {
    const e = doc.data();
    const actor = e.actor;
    if (!actor) continue;
    if (e.type === 'REACTION_SENT')      reactionsByUid[actor] = (reactionsByUid[actor] || 0) + 1;
    if (e.type === 'PRESSURE_VOTE')      pressureByUid[actor]  = (pressureByUid[actor]  || 0) + 1;
    if (e.type === 'VOTE_CAST')          votedUids.add(actor);
    if (e.type === 'MISSION_COMPLETED')  missionsUids.add(actor);
  }

  const topReactorNickname = summary.topReactor?.nickname || null;
  const isLongSession      = (summary.durationSec || 0) > 1800;

  const awards = uniquePlayers.map((p) => {
    const uid = p.userId;

    const reactions    = reactionsByUid[uid] || 0;
    const pressure     = pressureByUid[uid]  || 0;
    const isTopReactor = topReactorNickname && p.nickname === topReactorNickname;
    const voted        = votedUids.has(uid);
    const missionsDone = missionsUids.has(uid) ? 1 : 0;

    const delta = 10
      + reactions
      + (isTopReactor ? 5 : 0)
      + (voted        ? 5 : 0)
      + (missionsDone * 15)
      + (isLongSession ? 5 : 0);

    // XP: escala diferente da reputação — alimenta o sistema de níveis (levelFromXP)
    const xpDelta = 50
      + Math.min((summary.cardsRevealed || 0) * 2, 100)
      + (isTopReactor ? 25 : 0)
      + (voted        ? 15 : 0)
      + (missionsDone * 30)
      + (isLongSession ? 25 : 0);

    return { uid, xpDelta, reputationDelta: delta, reactions, pressure, isTopReactor, missionsDone };
  });

  const admin     = require('firebase-admin');
  const now       = new Date();
  const markerRef = sessRef.collection('settlements').doc('account-v1');

  const outcome = await db.runTransaction(async tx => {
    const markerSnap = await tx.get(markerRef);
    if (markerSnap.exists && markerSnap.data()?.status === 'complete') {
      return {
        alreadySettled: true,
        awards: Array.isArray(markerSnap.data()?.awards) ? markerSnap.data().awards : [],
      };
    }

    // Todas as leituras precedem as escritas, como exigido pelo Firestore.
    const userRefs = awards.map(award => db.collection('users').doc(award.uid));
    for (const userRef of userRefs) await tx.get(userRef);

    awards.forEach((award, index) => {
      tx.set(userRefs[index], {
        uid: award.uid,
        userId: award.uid,
        xp: admin.firestore.FieldValue.increment(award.xpDelta),
        reputation: {
          score:           admin.firestore.FieldValue.increment(award.reputationDelta),
          totalSessions:   admin.firestore.FieldValue.increment(1),
          totalReactions:  admin.firestore.FieldValue.increment(award.reactions),
          topReactorCount: admin.firestore.FieldValue.increment(award.isTopReactor ? 1 : 0),
          lastUpdatedAt:   now,
          lastSessionId:   sessionId,
        },
        stats: {
          gamesPlayed:        admin.firestore.FieldValue.increment(1),
          wins:               admin.firestore.FieldValue.increment(award.missionsDone ? 1 : 0),
          missionsCompleted:  admin.firestore.FieldValue.increment(award.missionsDone),
          pressureVotes:      admin.firestore.FieldValue.increment(award.pressure),
        },
        lastRoomId:    roomId,
        lastSessionAt: now,
        updatedAt:     now,
      }, { merge: true });
    });

    tx.set(markerRef, {
      status: 'complete',
      version: 1,
      roomId,
      sessionId,
      awards,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { alreadySettled: false, awards };
  });

  if (!outcome.alreadySettled) {
    for (const award of outcome.awards) {
      events.emit('user.xp_awarded', {
        uid: award.uid,
        xpDelta: award.xpDelta,
        sessionId,
        roomId,
      });
    }
    logger.info({ sessionId, players: outcome.awards.length }, 'reputation_updated');
  }

  return { ok: true, ...outcome };
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getReputation(uid) {
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const rep = snap.data().reputation || {};
  return {
    uid,
    score:           rep.score           || 0,
    level:           reputationLevel(rep.score || 0),
    totalSessions:   rep.totalSessions   || 0,
    totalReactions:  rep.totalReactions  || 0,
    topReactorCount: rep.topReactorCount || 0,
    dailyRitualsCompleted: rep.dailyRitualsCompleted || 0,
    lastUpdatedAt:   rep.lastUpdatedAt?.toMillis?.() || null,
    lastSessionId:   rep.lastSessionId   || null,
  };
}

module.exports = { init, getReputation, reputationLevel, settleSessionAccounts };
