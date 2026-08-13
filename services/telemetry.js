'use strict';

/**
 * services/telemetry.js — Telemetria da plataforma
 *
 * Lê platform_events (coleção global persistida pelo EventBus) e agrega
 * métricas de sessão, conteúdo e engajamento.
 *
 * Um único query de 7 dias é feito por vez; o resultado fica cached 5min.
 * Janelas menores (24h) são computadas como subsets no lado do servidor.
 *
 * API:
 *   getStats()          → { stats24h, stats7d, topTopics24h, topTopics7d }
 *   invalidateCache()   → limpa cache (útil após eventos em staging)
 */

const logger = require('../logger');

const CACHE_TTL_MS = 5 * 60_000;   // 5 minutos
const WINDOW_7D_MS = 7 * 24 * 3600_000;
const WINDOW_24H_MS = 24 * 3600_000;

let _cache = null;  // { data, expiresAt }

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getStats() {
  if (_cache && _cache.expiresAt > Date.now()) return _cache.data;

  const data = await _compute().catch(err => {
    logger.warn({ err }, 'telemetry_compute_failed');
    return _emptyStats();
  });

  _cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

function invalidateCache() {
  _cache = null;
}

// ── Computação ────────────────────────────────────────────────────────────────

async function _compute() {
  const db = getDb();
  if (!db) return _emptyStats();

  const since7d = Date.now() - WINDOW_7D_MS;
  const since24h = Date.now() - WINDOW_24H_MS;

  const snap = await db.collection('platform_events')
    .where('ts', '>=', since7d)
    .get();

  const all7d  = snap.docs.map(d => d.data());
  const all24h = all7d.filter(e => e.ts >= since24h);

  return {
    stats24h:    _aggregateSessionStats(all24h),
    stats7d:     _aggregateSessionStats(all7d),
    topTopics24h: _countTopics(all24h),
    topTopics7d:  _countTopics(all7d),
    computedAt:  Date.now(),
  };
}

function _aggregateSessionStats(events) {
  let sessions = 0;
  let cardsRevealed = 0;
  let reactions = 0;
  let votes = 0;
  let totalDurationSec = 0;

  for (const e of events) {
    if (e.topic === 'session.ended' && e.payload?.summary) {
      sessions++;
      cardsRevealed    += e.payload.summary.cardsRevealed  || 0;
      votes            += e.payload.summary.votesTotal      || 0;
      totalDurationSec += e.payload.summary.durationSec    || 0;
    }
    if (e.topic === 'ritual.reaction_sent') reactions++;
  }

  return {
    sessions,
    cardsRevealed,
    reactions,
    votes,
    avgDurationSec: sessions > 0 ? Math.round(totalDurationSec / sessions) : 0,
  };
}

function _countTopics(events) {
  const counts = {};
  for (const e of events) {
    counts[e.topic] = (counts[e.topic] || 0) + 1;
  }
  // Retorna ordenado por contagem decrescente
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
}

function _emptyStats() {
  const empty = { sessions: 0, cardsRevealed: 0, reactions: 0, votes: 0, avgDurationSec: 0 };
  return { stats24h: { ...empty }, stats7d: { ...empty }, topTopics24h: {}, topTopics7d: {}, computedAt: Date.now() };
}

module.exports = { getStats, invalidateCache };
