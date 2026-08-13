'use strict';

/**
 * Entitlements — fonte única de verdade sobre o que cada usuário pode fazer.
 *
 * Consolida em uma única operação Firestore (com cache TTL 120s) o que hoje
 * está espalhado em isPrestige(), isPassActive() e buildVerifiedDeck():
 *   · Nível e tier (free / prestige)
 *   · Packs de cartas desbloqueados
 *   · Passes mensais de gravação e streaming
 *
 * Permissões avaliadas por can():
 *   'game.prestige'        — nível 50+ ou flag prestige=true
 *   'game.pack.<packId>'   — tem o pack (ou é prestige)
 *   'session.record'       — pode gravar  (pass mensal ou prestige)
 *   'session.stream'       — pode streamar (pass mensal ou prestige)
 */

const { levelFromXP, OSL_PACK_IDS } = require('../data/cards');
const logger = require('../logger');

const CACHE_TTL_MS   = 120_000;  // 2 minutos
const PRESTIGE_LEVEL = 50;

const _cache = new Map();  // uid → { data, expiresAt }

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Retorna o objeto de entitlements completo para o uid (com cache).
 * Nunca lança — em caso de falha retorna objeto vazio seguro.
 */
async function getUserEntitlements(uid) {
  if (!uid) return _empty(null);

  const cached = _cache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const data = await _fetch(uid);
    _cache.set(uid, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.warn({ err, uid }, 'entitlements_fetch_error');
    return cached?.data ?? _empty(uid);  // stale fallback em falha de rede
  }
}

/**
 * Verifica se o uid tem a permissão especificada.
 * Nunca lança.
 */
async function can(uid, permission) {
  const ent = await getUserEntitlements(uid);
  return _check(ent, permission);
}

/**
 * Invalida o cache de um uid específico.
 * Chamar após processar compras ou mudanças de tier.
 */
function invalidate(uid) {
  if (uid) _cache.delete(uid);
}

function invalidateAll() {
  _cache.clear();
}

// ── Fetch do Firestore ────────────────────────────────────────────────────────

async function _fetch(uid) {
  const db = getDb();
  if (!db) return _empty(uid);

  // Lê perfil do usuário em primeiro lugar para obter o email
  const userSnap = await db.collection('users').doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const email    = userData.email || null;

  // Lê passes em paralelo — indexados por email
  const [recSnap, strSnap] = await Promise.all([
    email ? db.collection('recording_passes').doc(email).get()  : Promise.resolve(null),
    email ? db.collection('streaming_passes').doc(email).get()  : Promise.resolve(null),
  ]);

  const now      = Date.now();
  const level    = levelFromXP(userData.xp || 0);
  const isPrestige = (userData.prestige === true) || (level >= PRESTIGE_LEVEL);

  // Prestige desbloqueia todos os packs automaticamente
  const unlockedPacks = isPrestige
    ? [...OSL_PACK_IDS]
    : (userData.compras || [])
        .filter(c => OSL_PACK_IDS.includes(c.produto))
        .map(c => c.produto);

  const recData = recSnap?.exists ? recSnap.data() : null;
  const strData = strSnap?.exists ? strSnap.data() : null;

  return {
    uid,
    email,
    level,
    isPrestige,
    unlockedPacks,
    hasRecordingPass:        recData ? (recData.expiresAt > now) : false,
    recordingPassExpiresAt:  recData?.expiresAt ?? null,
    hasStreamingPass:        strData ? (strData.expiresAt > now) : false,
    streamingPassExpiresAt:  strData?.expiresAt ?? null,
    compras:                 userData.compras || [],
    fetchedAt:               now,
  };
}

// ── Verificação de permissão ──────────────────────────────────────────────────

function _check(ent, permission) {
  if (!ent) return false;

  switch (permission) {
    case 'game.prestige':   return ent.isPrestige;
    case 'session.record':  return ent.isPrestige || ent.hasRecordingPass;
    case 'session.stream':  return ent.isPrestige || ent.hasStreamingPass;
  }

  if (permission.startsWith('game.pack.')) {
    const packId = permission.slice('game.pack.'.length);
    return ent.isPrestige || ent.unlockedPacks.includes(packId);
  }

  return false;
}

function _empty(uid) {
  return {
    uid: uid ?? null,
    email: null,
    level: 0,
    isPrestige: false,
    unlockedPacks: [],
    hasRecordingPass: false,
    recordingPassExpiresAt: null,
    hasStreamingPass: false,
    streamingPassExpiresAt: null,
    compras: [],
    fetchedAt: Date.now(),
  };
}

module.exports = { getUserEntitlements, can, invalidate, invalidateAll };
