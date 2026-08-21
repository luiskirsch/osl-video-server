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
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

const WORLD_DOC = 'world_state/current';
const CACHE_TTL = 60_000; // 1 min
const WORLD_ACTIVITY_LIMIT = 18;
const TERRITORIES = Object.freeze([
  { id: 'limiar', name: 'O Limiar', threshold: 0, sigil: '◉', palette: ['#d4af37', '#10202a'], affinity: ['Ritual', 'Conexão'], effect: 'Cartas de Ritual e Conexão atravessam o início do deck e abrem a sessão sob sua presença.', lore: 'Onde toda conversa abandona o cotidiano e se torna ritual.' },
  { id: 'entrelinhas', name: 'Entrelinhas', threshold: .25, sigil: '△', palette: ['#60a6a8', '#081b22'], affinity: ['Pergunta', 'Segredo'], effect: 'Perguntas e Segredos são trazidos para os primeiros atos e carregam ecos das sessões recentes.', lore: 'O território das palavras evitadas e das memórias compartilhadas.' },
  { id: 'camara', name: 'A Câmara', threshold: .55, sigil: '□', palette: ['#a884d8', '#150e20'], affinity: ['Desafio', 'Missão'], effect: 'Desafios e Missões formam uma escalada deliberada depois que o grupo cruza a abertura.', lore: 'Tudo que o grupo escolhe fazer permanece registrado aqui.' },
  { id: 'sexto_lugar', name: 'O Sexto Lugar', threshold: .85, sigil: '◇', palette: ['#f0e4bd', '#26180d'], affinity: ['Reflexão', 'Decisão Coletiva'], effect: 'Reflexões e Decisões Coletivas atravessam qualquer deck em quatro momentos decisivos.', lore: 'Um lugar criado apenas quando pessoas escolhem estar verdadeiramente presentes.' },
]);

let _cache = null; // { data, expiresAt }

function _defaultState() {
  return {
    communityProgress:      0,
    currentMissionId:       null,
    unlockedContent:        [],
    totalDailyParticipants: 0,
    territoryContributions: {},
    recentEchoes:           [],
    updatedAt:              admin.firestore.FieldValue.serverTimestamp(),
  };
}

function _timestampMs(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return value?.toMillis?.() ?? null;
}

function _territoryView(raw, progress) {
  const contributions = raw.territoryContributions || {};
  return TERRITORIES.map((territory, index) => ({ ...territory, index,
    unlocked: progress >= territory.threshold,
    contribution: Number(contributions[territory.id] || 0),
    nextThreshold: TERRITORIES[index + 1]?.threshold ?? 1,
  }));
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

  const communityProgress = Math.min(1, Math.max(0, raw.communityProgress || 0));
  const territories = _territoryView(raw, communityProgress);
  const activeTerritory = [...territories].reverse().find(t => t.unlocked) || territories[0];
  const data = {
    communityProgress,
    currentMission,
    unlockedContent:        raw.unlockedContent || [],
    totalDailyParticipants: raw.totalDailyParticipants || 0,
    territories,
    activeTerritory,
    activeInfluence: { territoryId: activeTerritory.id, name: activeTerritory.name, sigil: activeTerritory.sigil, palette: activeTerritory.palette, affinity: activeTerritory.affinity, effect: activeTerritory.effect },
    recentEchoes: (Array.isArray(raw.recentEchoes) ? raw.recentEchoes : []).slice(-WORLD_ACTIVITY_LIMIT).reverse().map(echo => ({ territoryId: String(echo.territoryId || 'limiar').slice(0, 40), kind: String(echo.kind || 'ritual_completed').slice(0, 40), players: Math.max(1, Number(echo.players || 1)), at: _timestampMs(echo.at) })),
    updatedAt:              raw.updatedAt?.toMillis?.() ?? null,
  };

  _cache = { data, expiresAt: Date.now() + CACHE_TTL };
  return data;
}

function _territoryForSummary(summary = {}) {
  const counts = summary.cardTypeCounts || {};
  const score = territory => territory.affinity.reduce((sum, type) => sum + Number(counts[type] || 0), 0);
  return [...TERRITORIES].sort((a, b) => score(b) - score(a))[0] || TERRITORIES[0];
}

async function recordWorldActivity({ sessionId, playerCount, summary } = {}) {
  const db = getDb();
  if (!db || !sessionId) return;
  const territory = _territoryForSummary(summary), ref = db.doc(WORLD_DOC);
  _cache = null;
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref), raw = snap.exists ? snap.data() : {};
    const echoes = Array.isArray(raw.recentEchoes) ? raw.recentEchoes.slice(-(WORLD_ACTIVITY_LIMIT - 1)) : [];
    echoes.push({ id: String(sessionId).slice(0, 120), territoryId: territory.id, kind: 'ritual_completed', players: Math.max(1, Number(playerCount || 1)), at: new Date() });
    tx.set(ref, { recentEchoes: echoes, territoryContributions: { ...(raw.territoryContributions || {}), [territory.id]: Number(raw.territoryContributions?.[territory.id] || 0) + Math.max(1, Number(playerCount || 1)) }, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function applyWorldInfluence(deck) {
  if (!Array.isArray(deck) || !deck.length) return deck;
  const state = await getWorldState().catch(() => null), influence = state?.activeInfluence;
  if (!influence) return deck;
  // O território altera a cadência emocional sem remover cartas: até quatro
  // cartas afins são promovidas para beats definidos e recebem identidade visual.
  const selected = [], remaining = [];
  for (const card of deck) {
    if (selected.length < 4 && influence.affinity.includes(card.type)) selected.push({ ...card, worldInfluence: influence });
    else remaining.push(card);
  }
  if (!selected.length) return deck;
  const beats = {
    limiar: [0, 3, 7, 12],
    entrelinhas: [2, 5, 9, 14],
    camara: [3, 6, 10, 15],
    sexto_lugar: [1, 4, 8, 13],
  }[influence.territoryId] || [1, 4, 8, 13];
  selected.forEach((card, index) => remaining.splice(Math.min(beats[index], remaining.length), 0, card));
  return remaining;
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
    const { sessionId, playerCount, summary } = payload || {};
    if (!sessionId) return;

    const amount = 0.001 * Math.max(1, playerCount || 1);
    await contributeProgress(amount).catch(() => {});
    await recordWorldActivity({ sessionId, playerCount, summary }).catch(err => logger.warn({ err }, 'world_activity_record_failed'));

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
  contributeMission, recordWorldActivity, applyWorldInfluence, TERRITORIES, invalidate, init,
};
