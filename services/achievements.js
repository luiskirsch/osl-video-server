'use strict';

/**
 * services/achievements.js — Sistema de conquistas (P2 extensão)
 *
 * Conquistas são desbloqueadas de forma assíncrona quando métricas do jogador
 * atingem limiares definidos no catálogo. O estado fica em:
 *
 *   users/{uid}.achievements.{achievementId}: {
 *     unlockedAt: Timestamp,
 *     progress:   number   (só para conquistas com progress tracking)
 *   }
 *
 * Eventos emitidos no desbloqueio:
 *   user.achievement_unlocked  { uid, achievementId, title }
 *
 * API pública:
 *   getAchievements(uid)   → { catalog: Achievement[], unlocked: { [id]: {...} } }
 *   getCatalog()           → Achievement[]
 *   init()                 → registra listeners no EventBus
 */

const logger = require('../logger');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── Catálogo ──────────────────────────────────────────────────────────────────

const CATALOG = [
  {
    id:          'first_game',
    title:       'Primeira Sessão',
    description: 'Joguou sua primeira sessão.',
    icon:        '🎴',
    category:    'milestone',
    rarity:      'common',
  },
  {
    id:          'session_5',
    title:       'Jogador Regular',
    description: 'Participou de 5 sessões.',
    icon:        '🎮',
    category:    'milestone',
    rarity:      'common',
    progressTarget: 5,
  },
  {
    id:          'session_20',
    title:       'Veterano',
    description: 'Participou de 20 sessões.',
    icon:        '⚔️',
    category:    'milestone',
    rarity:      'rare',
    progressTarget: 20,
  },
  {
    id:          'session_50',
    title:       'Lendário',
    description: 'Participou de 50 sessões.',
    icon:        '👑',
    category:    'milestone',
    rarity:      'legendary',
    progressTarget: 50,
  },
  {
    id:          'top_reactor_3',
    title:       'Alma da Festa',
    description: 'Foi o jogador mais reativo em 3 sessões.',
    icon:        '🔥',
    category:    'engagement',
    rarity:      'uncommon',
    progressTarget: 3,
  },
  {
    id:          'top_reactor_10',
    title:       'Presença Constante',
    description: 'Foi o jogador mais reativo em 10 sessões.',
    icon:        '⚡',
    category:    'engagement',
    rarity:      'rare',
    progressTarget: 10,
  },
  {
    id:          'marathon',
    title:       'Maratona',
    description: 'Jogou uma sessão com 60 cartas ou mais.',
    icon:        '🏃',
    category:    'session',
    rarity:      'uncommon',
  },
  {
    id:          'daily_ritual_3',
    title:       'Devoto',
    description: 'Completou o Ritual Diário 3 vezes.',
    icon:        '🌅',
    category:    'live',
    rarity:      'uncommon',
    progressTarget: 3,
  },
  {
    id:          'daily_ritual_10',
    title:       'Ritualista',
    description: 'Completou o Ritual Diário 10 vezes.',
    icon:        '🌟',
    category:    'live',
    rarity:      'rare',
    progressTarget: 10,
  },
  {
    id:          'social_5',
    title:       'Conectado',
    description: 'Jogou com 5 jogadores diferentes.',
    icon:        '🤝',
    category:    'social',
    rarity:      'uncommon',
    progressTarget: 5,
  },
  {
    id:          'social_20',
    title:       'Borboleta Social',
    description: 'Jogou com 20 jogadores diferentes.',
    icon:        '🦋',
    category:    'social',
    rarity:      'rare',
    progressTarget: 20,
  },
  {
    id:          'voted',
    title:       'Participou da Democracia',
    description: 'Votou pela primeira vez.',
    icon:        '🗳️',
    category:    'engagement',
    rarity:      'common',
  },
  {
    id:          'mission',
    title:       'Missionário',
    description: 'Completou uma missão.',
    icon:        '🎯',
    category:    'engagement',
    rarity:      'common',
  },
];

const CATALOG_MAP = Object.fromEntries(CATALOG.map(a => [a.id, a]));

function getCatalog() {
  return CATALOG;
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getAchievements(uid) {
  const db = getDb();
  if (!db || !uid) return { catalog: CATALOG, unlocked: {} };

  const snap = await db.collection('users').doc(uid).get();
  const unlocked = snap.exists ? (snap.data().achievements || {}) : {};

  // Serializa Timestamps para millis
  const normalized = {};
  for (const [id, data] of Object.entries(unlocked)) {
    normalized[id] = {
      ...data,
      unlockedAt: data.unlockedAt?.toMillis?.() ?? data.unlockedAt ?? null,
    };
  }

  return { catalog: CATALOG, unlocked: normalized };
}

// ── Unlock de conquistas ──────────────────────────────────────────────────────

async function _checkAndUnlock(uid, achievementId, { progress } = {}) {
  if (!uid || !CATALOG_MAP[achievementId]) return false;

  const db  = getDb();
  if (!db) return false;

  const ref  = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return false;

  const existing = snap.data().achievements?.[achievementId];
  if (existing?.unlockedAt) return false;  // já desbloqueado

  const update = {
    [`achievements.${achievementId}.unlockedAt`]: new Date(),
  };
  if (progress !== undefined) {
    update[`achievements.${achievementId}.progress`] = progress;
  }

  await ref.update(update).catch(() => {});

  const events = require('./events');
  events.emit('user.achievement_unlocked', {
    uid,
    achievementId,
    title: CATALOG_MAP[achievementId].title,
  });

  logger.info({ uid, achievementId }, 'achievement_unlocked');
  return true;
}

// ── Listeners ─────────────────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events    = require('./events');
  const reputation = require('./reputation');

  events.on('session.ended', async ({ payload }) => {
    const { players, summary } = payload || {};
    if (!players || !summary) return;

    const authedPlayers = players.filter(p => p.userId);
    if (!authedPlayers.length) return;

    for (const player of authedPlayers) {
      const uid = player.userId;

      try {
        const rep = await reputation.getReputation(uid);
        const sessionCount = rep?.totalSessions || 0;

        // Milestone de sessões
        if (sessionCount === 1) await _checkAndUnlock(uid, 'first_game');
        if (sessionCount >= 5)  await _checkAndUnlock(uid, 'session_5',  { progress: Math.min(sessionCount, 5) });
        if (sessionCount >= 20) await _checkAndUnlock(uid, 'session_20', { progress: Math.min(sessionCount, 20) });
        if (sessionCount >= 50) await _checkAndUnlock(uid, 'session_50', { progress: Math.min(sessionCount, 50) });

        // Top reactor
        const topReactorCount = rep?.topReactorCount || 0;
        if (topReactorCount >= 3)  await _checkAndUnlock(uid, 'top_reactor_3',  { progress: Math.min(topReactorCount, 3) });
        if (topReactorCount >= 10) await _checkAndUnlock(uid, 'top_reactor_10', { progress: Math.min(topReactorCount, 10) });

        // Maratona
        if ((summary.cardsRevealed || 0) >= 60) await _checkAndUnlock(uid, 'marathon');

      } catch (err) {
        logger.warn({ err, uid }, 'achievement_check_error');
      }
    }
  });

  // Voto
  events.on('session.ended', async ({ payload }) => {
    const { players, sessionId, roomId } = payload || {};
    if (!players || !sessionId) return;

    const authedPlayers = players.filter(p => p.userId);
    if (!authedPlayers.length) return;

    try {
      const db   = getDb();
      if (!db) return;
      const snap = await db.collection('salas').doc(roomId)
        .collection('sessions').doc(sessionId)
        .collection('events').where('type', '==', 'VOTE_CAST').get();
      if (snap.empty) return;

      const voterUids = new Set(snap.docs.map(d => d.data().actor).filter(Boolean));
      for (const uid of voterUids) {
        await _checkAndUnlock(uid, 'voted').catch(() => {});
      }
    } catch (_) {}
  });

  // Missão
  events.on('session.ended', async ({ payload }) => {
    const { players, sessionId, roomId } = payload || {};
    if (!players || !sessionId) return;

    const authedPlayers = players.filter(p => p.userId);
    if (!authedPlayers.length) return;

    try {
      const db   = getDb();
      if (!db) return;
      const snap = await db.collection('salas').doc(roomId)
        .collection('sessions').doc(sessionId)
        .collection('events').where('type', '==', 'MISSION_COMPLETED').get();
      if (snap.empty) return;

      const completedUids = new Set(snap.docs.map(d => d.data().actor).filter(Boolean));
      for (const uid of completedUids) {
        await _checkAndUnlock(uid, 'mission').catch(() => {});
      }
    } catch (_) {}
  });

  // Social: monitora quando jogadores são adicionados à social_connections
  events.on('user.achievement_unlocked', () => {});  // mantém listener vivo

  // Ritual diário completado — authedUids vem direto do evento
  events.on('live.daily_ritual_completed', async ({ payload }) => {
    const { authedUids } = payload || {};
    if (!Array.isArray(authedUids) || !authedUids.length) return;

    for (const uid of authedUids) {
      try {
        const rep        = await reputation.getReputation(uid).catch(() => null);
        const dailyCount = rep?.dailyRitualsCompleted || 0;

        if (dailyCount >= 3)  await _checkAndUnlock(uid, 'daily_ritual_3',  { progress: Math.min(dailyCount, 3) }).catch(() => {});
        if (dailyCount >= 10) await _checkAndUnlock(uid, 'daily_ritual_10', { progress: Math.min(dailyCount, 10) }).catch(() => {});
      } catch (err) {
        logger.warn({ err, uid }, 'achievement_daily_check_error');
      }
    }
  });

  // Social: verifica conquistas de conexões após session.ended
  events.on('session.ended', async ({ payload }) => {
    const { players } = payload || {};
    if (!players) return;

    const authedPlayers = players.filter(p => p.userId);
    if (authedPlayers.length < 2) return;

    try {
      const socialGraph = require('./socialGraph');
      for (const player of authedPlayers) {
        const uid  = player.userId;
        const conns = await socialGraph.getConnections(uid, 50);
        const uniqueCount = conns.length;

        if (uniqueCount >= 5)  await _checkAndUnlock(uid, 'social_5',  { progress: Math.min(uniqueCount, 5) }).catch(() => {});
        if (uniqueCount >= 20) await _checkAndUnlock(uid, 'social_20', { progress: Math.min(uniqueCount, 20) }).catch(() => {});
      }
    } catch (_) {}
  });

  logger.info({}, 'achievements_initialized');
}

module.exports = { init, getCatalog, getAchievements };
