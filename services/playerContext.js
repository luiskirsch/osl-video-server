'use strict';

/**
 * services/playerContext.js — Contexto unificado de jogador/grupo
 *
 * Agrega dados de múltiplos serviços em uma representação única.
 * Outros motores (content, contextual, compatibility) recebem CONTEXT —
 * não precisam conhecer 15 serviços individualmente.
 *
 * Context {
 *   player   — { history, mastery, preferences, playStyle, cardTypeAffinity }
 *   group    — { dna, size, isRecurring }
 *   temporal — { hourBrazil, dayOfWeek, activeEvents, activeSeason }
 *   world    — { communityProgress, currentMission }
 *   mode     — 'ritual' | 'quick' | 'duo'
 *   groupSize
 * }
 */

const logger = require('../logger');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── Player context ─────────────────────────────────────────────────────────────

async function buildPlayerContext(uid) {
  if (!uid) return null;
  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('users').doc(uid).get().catch(() => null);
  if (!snap?.exists) return { uid };

  const data = snap.data();
  const rep  = data.reputation || {};

  const lastSessionAt = data.lastSessionAt instanceof Date
    ? data.lastSessionAt
    : data.lastSessionAt?.toDate?.() ?? null;

  return {
    uid,
    totalSessions:    rep.totalSessions    || 0,
    totalXP:          data.xp              || 0,
    reputationScore:  rep.score            || 0,
    lastSessionAt:    lastSessionAt?.getTime()                                  ?? null,
    daysSinceLast:    lastSessionAt ? (Date.now() - lastSessionAt.getTime()) / 86400000 : null,
    playStyle:        data.playStyle        || null,
    cardTypeAffinity: data.cardTypeAffinity || {},
    isFirstSession:   (rep.totalSessions    || 0) === 0,
    dailyRitualsCompleted: rep.dailyRitualsCompleted || 0,
  };
}

// ── Group context ──────────────────────────────────────────────────────────────

async function buildGroupContext(roomId, uids = []) {
  const [dnaResult, recurringResult] = await Promise.allSettled([
    roomId ? require('./sessionDna').getRoomDna(roomId) : Promise.resolve(null),
    roomId ? _isRecurringRoom(roomId)                  : Promise.resolve(false),
  ]);

  return {
    size:        uids.length,
    uids,
    dna:         dnaResult.status      === 'fulfilled' ? dnaResult.value      : null,
    isRecurring: recurringResult.status === 'fulfilled' ? recurringResult.value : false,
  };
}

async function _isRecurringRoom(roomId) {
  const db = getDb();
  if (!db) return false;
  const snap = await db.collection('recurring_schedules')
    .where('roomId', '==', roomId)
    .where('active', '==', true)
    .limit(1)
    .get().catch(() => null);
  return !snap?.empty;
}

// ── Temporal context ───────────────────────────────────────────────────────────

function buildTemporalContext() {
  const now  = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  // Brasil UTC-3, sem horário de verão desde 2019
  let brH = utcH - 3;
  if (brH < 0) brH += 24;

  return {
    hourBrazil:    brH,
    minuteBrazil:  utcM,
    dayOfWeek:     now.getUTCDay(), // 0=dom, 6=sáb
    isoDate:       now.toISOString().split('T')[0],
  };
}

// ── Session context completo ───────────────────────────────────────────────────

/**
 * Constrói o contexto completo pré-sessão.
 * Chamado em routes/ritual.js após reorderDeck.
 *
 * @param {{ hostUid: string, players: object[], roomId: string, mode?: string }} opts
 */
async function buildSessionContext({ hostUid, players = [], roomId, mode } = {}) {
  const temporal = buildTemporalContext();
  const uids     = players.map(p => p.userId).filter(Boolean);

  const [playerRes, groupRes, worldRes, liveRes] = await Promise.allSettled([
    hostUid ? buildPlayerContext(hostUid) : Promise.resolve(null),
    buildGroupContext(roomId, uids),
    require('./worldState').getWorldState().catch(() => null),
    Promise.all([
      require('./liveService').getActiveEvents().catch(() => []),
      require('./liveService').getActiveSeason().catch(() => null),
    ]).then(([events, season]) => ({ events: events || [], season })),
  ]);

  return {
    player:    playerRes.status === 'fulfilled' ? playerRes.value : null,
    group:     groupRes.status  === 'fulfilled' ? groupRes.value  : { size: players.length, uids, dna: null, isRecurring: false },
    world:     worldRes.status  === 'fulfilled' ? worldRes.value  : null,
    live:      liveRes.status   === 'fulfilled' ? liveRes.value   : { events: [], season: null },
    temporal,
    mode:      mode      || 'ritual',
    groupSize: players.length,
  };
}

module.exports = {
  buildPlayerContext,
  buildGroupContext,
  buildTemporalContext,
  buildSessionContext,
};
