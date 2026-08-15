'use strict';

/**
 * services/experiments.js — Experimentação / A/B testing
 *
 * Experimentos ficam em Firestore (coleção "experiments/{name}").
 * Assinalamento de variante é determinístico por uid+experimento
 * (mesma técnica de hash bucket dos feature flags).
 *
 * Schema de um documento experiments/{name}:
 * {
 *   name:        string
 *   description: string
 *   enabled:     boolean
 *   variants:    string[]          ex: ['control', 'treatment']
 *   allocation:  { [variant]: % }  ex: { control: 70, treatment: 30 }
 *   overrides:   { [uid]: variant } — força variante para uids específicos
 *   blacklist:   string[]          — uids excluídos (recebem null)
 *   conversionCounts: { [event]: { [variant]: number } }
 *   createdAt:   Date
 *   updatedAt:   Date
 * }
 *
 * API pública:
 *   getVariant(name, uid)              → string | null
 *   getAllVariants(uid)                → { [expName]: variant }
 *   trackConversion(name, uid, event)  → void (fire-and-forget)
 *   listExperiments()                  → Experiment[]
 *   setExperiment(name, data)          → void
 *   deleteExperiment(name)             → void
 *   invalidateCache(name?)             → void
 */

const logger = require('../logger');

const CACHE_TTL_MS = 120_000;  // 2 minutos
const _cache = new Map();      // name → { data, expiresAt }

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Atribuição ────────────────────────────────────────────────────────────────

async function getVariant(name, uid = null) {
  const exp = await _getExperiment(name);
  if (!exp || !exp.enabled) return null;

  if (uid && exp.blacklist?.includes(uid)) return null;
  if (uid && exp.overrides?.[uid])         return exp.overrides[uid];

  if (!uid) return exp.variants?.[0] || null;

  const bucket     = _hashBucket(uid, name);
  const allocation = exp.allocation || {};
  let cumulative   = 0;
  for (const [variant, pct] of Object.entries(allocation)) {
    cumulative += pct;
    if (bucket < cumulative) return variant;
  }
  return exp.variants?.[0] || null;
}

async function getAllVariants(uid) {
  const exps = await listExperiments();
  const result = {};
  await Promise.all(
    exps.filter(e => e.enabled).map(async (e) => {
      const v = await getVariant(e.name, uid);
      if (v !== null) result[e.name] = v;
    })
  );
  return result;
}

// ── Tracking de conversão ─────────────────────────────────────────────────────

async function trackConversion(name, uid, eventName) {
  if (!uid || !eventName) return;
  const variant = await getVariant(name, uid);
  if (!variant) return;

  const db = getDb();
  if (!db) return;

  try {
    const admin = require('firebase-admin');
    await db.collection('experiments').doc(name).update({
      [`conversionCounts.${eventName}.${variant}`]:
        admin.firestore.FieldValue.increment(1),
      updatedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, name, uid, eventName }, 'experiment_track_conversion_failed');
  }
}

// ── CRUD (admin) ──────────────────────────────────────────────────────────────

async function listExperiments() {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collection('experiments').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function setExperiment(name, data) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const now         = new Date();
  const variants    = Array.isArray(data.variants) ? data.variants.slice(0, 6) : ['control', 'treatment'];
  const allocation  = _normalizeAllocation(data.allocation, variants);

  const doc = {
    name:        name,
    description: data.description ? String(data.description).slice(0, 500) : '',
    enabled:     data.enabled !== false,
    variants,
    allocation,
    overrides:   data.overrides   || {},
    blacklist:   Array.isArray(data.blacklist) ? data.blacklist : [],
    updatedAt:   now,
  };

  const existing = await db.collection('experiments').doc(name).get();
  if (!existing.exists) doc.createdAt = now;

  await db.collection('experiments').doc(name).set(doc, { merge: true });
  invalidateCache(name);
  logger.info({ name }, 'experiment_set');
}

async function deleteExperiment(name) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  await db.collection('experiments').doc(name).delete();
  invalidateCache(name);
}

function invalidateCache(name) {
  if (name) _cache.delete(name);
  else      _cache.clear();
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function _getExperiment(name) {
  const cached = _cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('experiments').doc(name).get().catch(() => null);
  const data = snap?.exists ? snap.data() : null;
  _cache.set(name, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

// Distribui alocação em percentuais, normaliza para somar 100
function _normalizeAllocation(raw, variants) {
  if (!raw || typeof raw !== 'object') {
    const pct = Math.floor(100 / variants.length);
    return Object.fromEntries(variants.map((v, i) =>
      [v, i === variants.length - 1 ? 100 - pct * i : pct]
    ));
  }
  return Object.fromEntries(
    variants.map(v => [v, typeof raw[v] === 'number' ? Math.max(0, Math.min(100, raw[v])) : 0])
  );
}

function _hashBucket(uid, name) {
  const str = `${uid}:${name}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h) % 100;
}

module.exports = {
  getVariant, getAllVariants, trackConversion,
  listExperiments, setExperiment, deleteExperiment, invalidateCache,
};
