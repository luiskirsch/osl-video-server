'use strict';

/**
 * services/worldState.js — World State + Community Missions
 *
 * Mantém um estado global do "mundo" do SextoLugar:
 *   - communityProgress (0–1): quanto a comunidade progrediu no período
 *   - currentMission: missão coletiva ativa (e.g. "10k sessões essa semana")
 *   - unlockedContent: conteúdo desbloqueado pela comunidade via missões
 *   - totalDailyParticipants: acumulado de rituais diários completados
 *
 * Firestore:
 *   world_state/current      — documento singleton
 *   community_missions/{id}  — catálogo de missões
 *
 * Fluxo:
 *   session.ended              → contributeProgress + contributeMission
 *   live.daily_ritual_completed → incrementDailyParticipants
 *   world.mission_completed    → unlock conteúdo (emitido internamente)
 */

const logger = require('../logger');
const admin  = require('firebase-admin');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

const WORLD_DOC = 'world_state/current';
const CACHE_TTL = 60_000; // 1 min

let _cache = null; // { data, expiresAt }

function _defaultState() {
  return {
    communityProgress:      0,
    currentMissionId:       null,
    unlockedContent:        [],
    totalDailyParticipants: 0,
    updatedAt:              admin.firestore.FieldValue.serverTimestamp(),
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getWorldState() {
  if (_cache && _cache.expiresAt > Date.now()) return _cache.data;

  const db = getDb();
  if (!db) return null;

  let raw;
  const snap = await db.doc(WORLD_DOC).get();
  if (!snap.exists) {
    raw = { communityProgress: 0, currentMissionId: null, unlockedContent: [], totalDailyParticipants: 0 };
    await db.doc(WORLD_DOC).set(_defaultState()).catch(() => {});
  } else {
    raw = snap.data();
  }

  // Carrega missão ativa (se houver)
  let currentMission = null;
  if (raw.currentMissionId) {
    const mSnap = await db.collection('community_missions').doc(raw.currentMissionId).get().catch(() => null);
    if (mSnap?.exists) {
      const m = mSnap.data();
      currentMission = {
        id:            m.id,
        name:          m.name,
        description:   m.description || '',
        goal:          m.goal,
        current:       m.current || 0,
        unit:          m.unit || 'sessões',
        progress:      Math.min(1, (m.current || 0) / m.goal),
        rewardContent: m.rewardContent || [],
        completedAt:   m.completedAt?.toMillis?.() ?? null,
      };
    }
  }

  const data = {
    communityProgress:      Math.min(1, Math.max(0, raw.communityProgress || 0)),
    currentMission,
    unlockedContent:        raw.unlockedContent || [],
    totalDailyParticipants: raw.totalDailyParticipants || 0,
    updatedAt:              raw.updatedAt?.toMillis?.() ?? null,
  };

  _cache = { data, expiresAt: Date.now() + CACHE_TTL };
  return data;
}

/**
 * Incrementa o progresso da comunidade.
 * amount: valor entre 0 e 1 (ex: 0.001 por sessão completada)
 */
async function contributeProgress(amount) {
  const db = getDb();
  if (!db) return;
  _cache = null;
  await db.doc(WORLD_DOC).update({
    communityProgress: admin.firestore.FieldValue.increment(amount),
    updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
  }).catch(async (err) => {
    // Documento ainda não existe — inicializa e tenta de novo
    if (err?.code === 5 || err?.message?.includes('NOT_FOUND')) {
      await db.doc(WORLD_DOC).set(_defaultState()).catch(() => {});
    }
  });
}

/**
 * Contribui para a missão comunitária ativa.
 * Usa transação para deduplicar o unlock de recompensa.
 */
async function contributeMission(missionId, amount) {
  const db = getDb();
  if (!db || !missionId) return;

  let justCompleted = false;
  let rewardContent = [];

  await db.runTransaction(async (tx) => {
    const ref  = db.collection('community_missions').doc(missionId);
    const snap = await tx.get(ref);
    if (!snap.exists || !snap.data().active) return;

    const d = snap.data();
    if (d.completedAt) return; // já completado anteriormente

    const newCurrent = (d.current || 0) + amount;
    justCompleted = newCurrent >= d.goal;
    rewardContent = d.rewardContent || [];

    tx.update(ref, {
      current:   admin.firestore.FieldValue.increment(amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(justCompleted ? { completedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    });

    if (justCompleted && rewardContent.length) {
      tx.update(db.doc(WORLD_DOC), {
        unlockedContent: admin.firestore.FieldValue.arrayUnion(...rewardContent),
        updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }).catch(err => logger.warn({ err, missionId }, 'mission_contribute_failed'));

  if (justCompleted) {
    _cache = null;
    const events = require('./events');
    events.emit('world.mission_completed', { missionId, rewardContent });
    logger.info({ missionId, rewardContent }, 'community_mission_completed');
  }
}

async function incrementDailyParticipants(count) {
  const db = getDb();
  if (!db) return;
  _cache = null;
  await db.doc(WORLD_DOC).update({
    totalDailyParticipants: admin.firestore.FieldValue.increment(count),
    updatedAt:              admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
}

/**
 * Patch administrativo do world state.
 * Aceita qualquer campo: currentMissionId, communityProgress, etc.
 */
async function setWorldState(patch) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  _cache = null;
  await db.doc(WORLD_DOC).set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function createMission(opts) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  const { id, name, description, goal, unit, rewardContent } = opts;
  if (!id || !name || !goal) throw Object.assign(new Error('MISSAO_INVALIDA'), { code: 400 });
  await db.collection('community_missions').doc(String(id)).set({
    id: String(id),
    name:          String(name).slice(0, 100),
    description:   String(description || '').slice(0, 500),
    goal:          Number(goal),
    current:       0,
    unit:          String(unit || 'sessões').slice(0, 50),
    rewardContent: Array.isArray(rewardContent) ? rewardContent : [],
    active:        true,
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function updateMission(id, patch) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  const allowed = {};
  if (patch.name        !== undefined) allowed.name        = String(patch.name).slice(0, 100);
  if (patch.description !== undefined) allowed.description = String(patch.description).slice(0, 500);
  if (patch.goal        !== undefined) allowed.goal        = Number(patch.goal);
  if (patch.unit        !== undefined) allowed.unit        = String(patch.unit).slice(0, 50);
  if (patch.active      !== undefined) allowed.active      = Boolean(patch.active);
  if (patch.rewardContent !== undefined) allowed.rewardContent = Array.isArray(patch.rewardContent) ? patch.rewardContent : [];
  allowed.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('community_missions').doc(String(id)).update(allowed);
}

async function listMissions({ activeOnly = false } = {}) {
  const db = getDb();
  if (!db) return [];
  let query = db.collection('community_missions').orderBy('createdAt', 'desc').limit(20);
  if (activeOnly) query = query.where('active', '==', true);
  const snap = await query.get();
  return snap.docs.map(d => {
    const m = d.data();
    return {
      id:            m.id,
      name:          m.name,
      description:   m.description,
      goal:          m.goal,
      current:       m.current || 0,
      unit:          m.unit,
      rewardContent: m.rewardContent || [],
      active:        m.active,
      progress:      Math.min(1, (m.current || 0) / m.goal),
      completedAt:   m.completedAt?.toMillis?.() ?? null,
      createdAt:     m.createdAt?.toMillis?.()   ?? null,
    };
  });
}

function invalidate() { _cache = null; }

// ── Init ──────────────────────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  // Cada sessão completada avança o progresso da comunidade
  events.on('session.ended', async ({ payload }) => {
    const { sessionId, playerCount } = payload || {};
    if (!sessionId) return;

    const amount = 0.001 * Math.max(1, playerCount || 1);
    await contributeProgress(amount).catch(() => {});

    try {
      const state = await getWorldState();
      if (state?.currentMission?.id && !state.currentMission.completedAt) {
        await contributeMission(state.currentMission.id, playerCount || 1);
      }
    } catch (err) {
      logger.warn({ err }, 'world_mission_contribute_failed');
    }
  });

  // Ritual do dia incrementa contador global
  events.on('live.daily_ritual_completed', async ({ payload }) => {
    const { authedUids } = payload || {};
    if (!Array.isArray(authedUids) || !authedUids.length) return;
    await incrementDailyParticipants(authedUids.length).catch(() => {});
  });

  logger.info('world_state_initialized');
}

module.exports = {
  getWorldState, contributeProgress, incrementDailyParticipants,
  setWorldState, createMission, updateMission, listMissions,
  contributeMission, invalidate, init,
};
