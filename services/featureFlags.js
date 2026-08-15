'use strict';

/**
 * Feature Flags — Firestore-backed com cache in-memory TTL 60s.
 *
 * Modelo de um documento em `feature_flags/{flagName}`:
 * {
 *   enabled:     boolean        — liga/desliga a flag globalmente
 *   rollout:     number 0–100   — % de usuários que recebem a flag (100 = todos)
 *   whitelist:   string[]       — UIDs que recebem sempre, independente do rollout
 *   blacklist:   string[]       — UIDs que nunca recebem
 *   description: string         — descrição legível para o admin
 *   updatedAt:   Timestamp
 * }
 *
 * Hierarquia de avaliação (do mais restritivo ao mais permissivo):
 *   1. flag inexistente ou enabled=false → false
 *   2. uid na blacklist                  → false
 *   3. uid na whitelist                  → true
 *   4. rollout < 100 → hash determinístico uid+flag → bucket 0–99 < rollout
 *   5. rollout = 100 → true
 */

const logger = require('../logger');

const CACHE_TTL_MS = 60_000;  // 1 minuto
const _cache = new Map();     // flagName → { data, expiresAt }

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Retorna true se a flag está habilitada para o uid (opcional).
 * É safe chamar sem uid — flags com rollout < 100 retornam false nesse caso.
 */
async function isEnabled(flagName, uid = null) {
  const flag = await _getFlag(flagName);
  if (!flag || !flag.enabled) return false;

  if (uid) {
    if (flag.blacklist?.includes(uid)) return false;
    if (flag.whitelist?.includes(uid)) return true;
  }

  const rollout = flag.rollout ?? 100;
  if (rollout >= 100) return true;
  if (!uid) return false;

  return _hashBucket(uid, flagName) < rollout;
}

/**
 * Retorna um mapa { flagName: boolean } com todos os flags habilitados para o uid.
 * Usado pelo frontend no bootstrap para saber quais features estão ativas.
 */
async function getEnabledFlags(uid = null) {
  const db = getDb();
  if (!db) return {};

  try {
    const snap = await db.collection('feature_flags').get();
    const result = {};
    await Promise.all(snap.docs.map(async doc => {
      result[doc.id] = await isEnabled(doc.id, uid);
    }));
    return result;
  } catch (err) {
    logger.warn({ err }, 'feature_flags_get_all_error');
    return {};
  }
}

/**
 * Lista todos os flags com seus configs (para o painel admin).
 */
async function listFlags() {
  const db = getDb();
  if (!db) return [];

  const snap = await db.collection('feature_flags').orderBy('updatedAt', 'desc').get();
  return snap.docs.map(doc => ({ name: doc.id, ...doc.data() }));
}

/**
 * Cria ou atualiza um flag. Invalida o cache da flag.
 */
async function setFlag(flagName, config = {}) {
  if (!flagName || typeof flagName !== 'string') throw new Error('FLAG_NAME_INVALIDO');

  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const data = {
    enabled:     typeof config.enabled === 'boolean' ? config.enabled : false,
    rollout:     typeof config.rollout === 'number'  ? Math.min(100, Math.max(0, config.rollout)) : 100,
    whitelist:   Array.isArray(config.whitelist)     ? config.whitelist.slice(0, 500) : [],
    blacklist:   Array.isArray(config.blacklist)     ? config.blacklist.slice(0, 500) : [],
    description: String(config.description || '').slice(0, 300),
    updatedAt:   new Date(),
  };

  await db.collection('feature_flags').doc(flagName).set(data, { merge: false });
  _cache.delete(flagName);

  const events = require('./events');
  events.emit('flag.updated', { flagName, ...data });

  logger.info({ flagName, enabled: data.enabled, rollout: data.rollout }, 'feature_flag_updated');
}

/**
 * Remove um flag do Firestore e do cache.
 */
async function deleteFlag(flagName) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  await db.collection('feature_flags').doc(flagName).delete();
  _cache.delete(flagName);

  logger.info({ flagName }, 'feature_flag_deleted');
}

/**
 * Força invalidação de cache (para testes ou após bulk update).
 * Sem argumento, limpa tudo.
 */
function invalidateCache(flagName = null) {
  if (flagName) _cache.delete(flagName);
  else _cache.clear();
}

// ── Internos ──────────────────────────────────────────────────────────────────

async function _getFlag(flagName) {
  const cached = _cache.get(flagName);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const db = getDb();
    if (!db) return cached?.data ?? null;

    const doc = await db.collection('feature_flags').doc(flagName).get();
    const data = doc.exists ? doc.data() : null;
    _cache.set(flagName, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.warn({ err, flagName }, 'feature_flag_fetch_error');
    return cached?.data ?? null;  // stale fallback em caso de falha de rede
  }
}

// Hash determinístico: mesmo uid+flag → sempre o mesmo bucket 0–99.
// Garante que o usuário sempre veja (ou não veja) a feature — sem flip-flop.
function _hashBucket(uid, flagName) {
  const str = `${uid}:${flagName}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h) % 100;
}

module.exports = { isEnabled, getEnabledFlags, listFlags, setFlag, deleteFlag, invalidateCache };
