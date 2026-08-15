'use strict';

/**
 * Content Engine — fonte de verdade para o conteúdo do jogo.
 *
 * Carrega cartas e packs do Firestore (coleção content_cards / content_packs)
 * com cache in-memory TTL 5 min. Se o Firestore estiver vazio ou indisponível,
 * cai automaticamente no conteúdo estático de data/cards.js.
 *
 * Isso permite editar cartas pelo painel admin sem deploy.
 *
 * Schema de um documento content_cards/{id}:
 * {
 *   packId:     string | null   — null = carta básica
 *   type:       string          — 'Ritual', 'Suspeita', 'Conexão', etc.
 *   title:      string
 *   text:       string
 *   rule?:      string
 *   subrule?:   string
 *   phrase?:    string
 *   effects?:   { battlecry?: Effect, deathrattle?: Effect }
 *   tags:       string[]        — ex: ['confessional', 'confrontational']
 *   intensity:  'low'|'medium'|'high'
 *   minPlayers: number          — padrão 2
 *   enabled:    boolean
 *   order:      number          — ordenação no CMS
 *   createdAt:  Timestamp
 *   updatedAt:  Timestamp
 * }
 *
 * API pública:
 *   getContentBundle()          → { basicCards, packCardsMap, effectsMap, packIds, packsMeta }
 *   getBasicCards()             → Card[]
 *   getPackCards(packId)        → Card[]
 *   getCardsByPackIds(packIds)  → Card[]  (union de múltiplos packs)
 *   getCardEffectsMap()         → { [title]: { battlecry?, deathrattle? } }
 *   getAllPackIds()              → string[]
 *   getPackMeta(packId)         → PackMeta | null
 *   getAllPacksMeta()            → { [packId]: PackMeta }
 *   invalidate()                → limpa cache (chame após editar conteúdo)
 */

const { OSL_BASIC_CARDS, OSL_PACK_CARDS, OSL_CARD_EFFECTS, OSL_PACK_IDS } = require('../data/cards');
const { logInfo, logWarn } = require('../logger');

const CACHE_TTL_MS = 5 * 60_000;  // 5 minutos

let _cache = null;     // { bundle, expiresAt }
let _loading = null;   // Promise em andamento (evita stampede)

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

function _staticBasicCards() {
  return OSL_BASIC_CARDS
    .filter(card => card && String(card.title || '').trim() && String(card.text || '').trim())
    .map(card => ({ ...card, tags: [], intensity: 'medium', minPlayers: 2 }));
}

function _normalizeFirestoreCard(id, data) {
  if (!data || typeof data !== 'object') return null;

  const title = String(data.title || '').trim().slice(0, 200);
  const text  = String(data.text  || '').trim().slice(0, 2000);
  if (!title || !text) return null;

  const intensity = ['low', 'medium', 'high'].includes(data.intensity)
    ? data.intensity
    : 'medium';
  const minPlayers = Number.isFinite(data.minPlayers) && data.minPlayers > 0
    ? Math.floor(data.minPlayers)
    : 2;

  return {
    id,
    type:       String(data.type || 'Ritual').slice(0, 50),
    title,
    text,
    rule:       data.rule    ? String(data.rule).slice(0, 1000)    : undefined,
    subrule:    data.subrule ? String(data.subrule).slice(0, 1000) : undefined,
    phrase:     data.phrase  ? String(data.phrase).slice(0, 500)   : undefined,
    tags:       Array.isArray(data.tags) ? data.tags.map(tag => String(tag).slice(0, 50)).slice(0, 20) : [],
    intensity,
    minPlayers,
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getContentBundle() {
  if (_cache && _cache.expiresAt > Date.now()) return _cache.bundle;
  if (_loading) return _loading;

  _loading = _load().finally(() => { _loading = null; });
  return _loading;
}

async function getBasicCards() {
  const b = await getContentBundle();
  return b.basicCards;
}

async function getPackCards(packId) {
  const b = await getContentBundle();
  return b.packCardsMap[packId] ?? [];
}

async function getCardsByPackIds(packIds = []) {
  const b = await getContentBundle();
  const result = [];
  for (const id of packIds) {
    if (b.packCardsMap[id]) result.push(...b.packCardsMap[id]);
  }
  return result;
}

async function getCardEffectsMap() {
  const b = await getContentBundle();
  return b.effectsMap;
}

async function getAllPackIds() {
  const b = await getContentBundle();
  return b.packIds;
}

async function getPackMeta(packId) {
  const b = await getContentBundle();
  return b.packsMeta?.[packId] ?? null;
}

async function getAllPacksMeta() {
  const b = await getContentBundle();
  return b.packsMeta ?? {};
}

function invalidate() {
  _cache = null;
  logInfo('content_engine_cache_invalidated');
}

// ── Carga do Firestore (com fallback estático) ────────────────────────────────

async function _load() {
  try {
    const bundle = await _loadFromFirestore();
    if (bundle) {
      _cache = { bundle, expiresAt: Date.now() + CACHE_TTL_MS };
      return bundle;
    }
  } catch (err) {
    logWarn('content_engine_firestore_error_fallback', {
      error: err?.message || String(err),
    });
  }

  // Fallback: dados estáticos (sempre funcionam, mesmo sem Firestore)
  const bundle = _buildBundleFromStatic();
  _cache = { bundle, expiresAt: Date.now() + CACHE_TTL_MS };
  return bundle;
}

async function _loadFromFirestore() {
  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('content_cards').where('enabled', '==', true).get();
  if (snap.empty) return null;  // dispara fallback para dados estáticos

  const basicCards    = [];
  const packCardsMap  = {};
  const effectsMap    = {};
  const packIdsSet    = new Set();
  let invalidCards    = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const card = _normalizeFirestoreCard(doc.id, d);
    if (!card) {
      invalidCards++;
      continue;
    }

    if (d.packId) {
      if (!packCardsMap[d.packId]) packCardsMap[d.packId] = [];
      packCardsMap[d.packId].push(card);
      packIdsSet.add(d.packId);
    } else {
      basicCards.push(card);
    }

    if (d.effects && (d.effects.battlecry || d.effects.deathrattle)) {
      effectsMap[card.title] = d.effects;
    }
  }

  // Um snapshot pode conter somente cartas de pacotes. Sem esta garantia,
  // jogadores sem entitlement recebem um deck vazio embora o CMS não esteja vazio.
  let usedStaticBasicFallback = false;
  if (basicCards.length === 0) {
    basicCards.push(..._staticBasicCards());
    for (const [title, effects] of Object.entries(OSL_CARD_EFFECTS)) {
      if (!effectsMap[title]) effectsMap[title] = effects;
    }
    usedStaticBasicFallback = true;
    logWarn('content_engine_basic_cards_static_fallback', {
      firestoreCards: snap.size,
      invalidCards,
      fallbackCards: basicCards.length,
    });
  }

  // Garante que packs conhecidos estejam presentes mesmo sem cartas carregadas
  for (const id of OSL_PACK_IDS) packIdsSet.add(id);

  // Metadata de packs da coleção content_packs
  const packsMeta = {};
  const metaSnap  = await db.collection('content_packs').get();
  for (const doc of metaSnap.docs) {
    packsMeta[doc.id] = { id: doc.id, ...doc.data() };
    packIdsSet.add(doc.id);
  }

  logInfo('content_engine_loaded_firestore', {
    basicCards: basicCards.length,
    packs: packIdsSet.size,
    effects: Object.keys(effectsMap).length,
    packsMeta: Object.keys(packsMeta).length,
    invalidCards,
    usedStaticBasicFallback,
  });

  return { basicCards, packCardsMap, effectsMap, packIds: [...packIdsSet], packsMeta };
}

function _buildBundleFromStatic() {
  const packCardsMap = {};
  for (const [packId, cards] of Object.entries(OSL_PACK_CARDS)) {
    packCardsMap[packId] = cards.map(c => ({ ...c, tags: [], intensity: 'medium', minPlayers: 2 }));
  }

  logInfo('content_engine_loaded_static', {
    basicCards: OSL_BASIC_CARDS.length,
    packs: OSL_PACK_IDS.length,
    effects: Object.keys(OSL_CARD_EFFECTS).length,
    source: 'static',
  });

  return {
    basicCards:   _staticBasicCards(),
    packCardsMap,
    effectsMap:   { ...OSL_CARD_EFFECTS },
    packIds:      [...OSL_PACK_IDS],
    packsMeta:    {},
  };
}

// ── Seed: importa dados estáticos para Firestore ──────────────────────────────
// Idempotente: não sobrescreve cartas já existentes (só insere novas).
async function seedFromStatic(overwrite = false) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const now = new Date();
  const batch = db.batch();
  let count = 0;

  // Verifica quais já existem para não sobrescrever
  const existing = new Set();
  if (!overwrite) {
    const snap = await db.collection('content_cards').get();
    snap.docs.forEach(d => existing.add(d.data().title));
  }

  const addCard = (card, packId, order) => {
    if (!overwrite && existing.has(card.title)) return;
    const ref = db.collection('content_cards').doc();
    const effects = OSL_CARD_EFFECTS[card._origTitle || card.title] || null;
    batch.set(ref, {
      packId:     packId ?? null,
      type:       card.type     || 'Ritual',
      title:      card.title    || '',
      text:       card.text     || '',
      rule:       card.rule     || null,
      subrule:    card.subrule  || null,
      phrase:     card.phrase   || null,
      effects:    effects ?? null,
      tags:       [],
      intensity:  'medium',
      minPlayers: 2,
      enabled:    true,
      order,
      createdAt:  now,
      updatedAt:  now,
    });
    count++;
  };

  OSL_BASIC_CARDS.forEach((c, i) => addCard(c, null, i));

  let order = 0;
  for (const [packId, cards] of Object.entries(OSL_PACK_CARDS)) {
    for (const card of cards) addCard(card, packId, order++);
  }

  if (count > 0) await batch.commit();

  invalidate();
  logInfo('content_engine_seeded', { count, overwrite });
  return count;
}

module.exports = {
  getContentBundle,
  getBasicCards,
  getPackCards,
  getCardsByPackIds,
  getCardEffectsMap,
  getAllPackIds,
  getPackMeta,
  getAllPacksMeta,
  invalidate,
  seedFromStatic,
};
