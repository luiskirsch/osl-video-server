'use strict';

/**
 * services/liveService.js — Live Service (P2)
 *
 * Gerencia conteúdo dinâmico que torna o jogo "vivo" entre sessões:
 *
 *  Seasons   — períodos temáticos com packIds exclusivos e multiplicador de XP
 *  Events    — eventos temporários com cartas bônus e XP extra
 *  Daily     — Ritual Diário gerado automaticamente do pool de cartas básicas;
 *              reseta à meia-noite UTC (≈21h São Paulo)
 *
 * Integração:
 *  - buildVerifiedDeck inclui getLivePackIds() no deck automaticamente
 *  - session.ended verifica se ritual diário foi jogado (via EventBus)
 *
 * Firestore:
 *  seasons/{id}               → schema Season
 *  live_events/{id}           → schema LiveEvent
 *  daily_ritual/{YYYY-MM-DD}  → schema DailyRitual
 *
 * API pública:
 *  getActiveSeason()           → Season | null
 *  getActiveEvents()           → LiveEvent[]
 *  getDailyRitual()            → DailyRitual | null
 *  getLivePackIds()            → string[]  (season + events)
 *  init()                      → registra listener session.ended
 */

const admin  = require('firebase-admin');
const logger = require('../logger');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Caches ────────────────────────────────────────────────────────────────────

const SEASON_TTL_MS = 10 * 60_000;   // 10 min
const EVENT_TTL_MS  =  5 * 60_000;   //  5 min

let _seasonCache  = null;   // { data, expiresAt }
let _eventsCache  = null;   // { data, expiresAt }
let _dailyCache   = null;   // { data, date }

// ── Seasons ───────────────────────────────────────────────────────────────────

async function getActiveSeason() {
  if (_seasonCache && _seasonCache.expiresAt > Date.now()) return _seasonCache.data;

  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('seasons').where('active', '==', true).get();
  const now  = Date.now();

  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => {
      const start = s.startAt?.toMillis?.() || 0;
      const end   = s.endAt?.toMillis?.()   || Infinity;
      return start <= now && end > now;
    })
    .sort((a, b) => (b.startAt?.toMillis?.() || 0) - (a.startAt?.toMillis?.() || 0))[0] || null;

  _seasonCache = { data: active, expiresAt: now + SEASON_TTL_MS };
  return active;
}

// ── Live Events ───────────────────────────────────────────────────────────────

async function getActiveEvents() {
  if (_eventsCache && _eventsCache.expiresAt > Date.now()) return _eventsCache.data;

  const db = getDb();
  if (!db) return [];

  const snap = await db.collection('live_events').where('active', '==', true).get();
  const now  = Date.now();

  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => {
      const start = e.startAt?.toMillis?.() || 0;
      const end   = e.endAt?.toMillis?.()   || Infinity;
      return start <= now && end > now;
    });

  _eventsCache = { data: active, expiresAt: now + EVENT_TTL_MS };
  return active;
}

// ── Daily Ritual ──────────────────────────────────────────────────────────────

function _todayStr() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD UTC
}

function _endOfDayUTC(dateStr) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function getDailyRitual() {
  const today = _todayStr();
  if (_dailyCache?.date === today) return _dailyCache.data;

  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('daily_ritual').doc(today).get();
  let ritual = snap.exists ? snap.data() : null;

  if (!ritual || !ritual.cardText) {
    ritual = await _generateDailyRitual(today, db).catch(err => {
      logger.warn({ err, today }, 'daily_ritual_generate_failed');
      return ritual; // mantém doc antigo se geração falhar
    });
  }

  _dailyCache = { data: ritual, date: today };
  return ritual;
}

async function _generateDailyRitual(dateStr, db) {
  const contentEngine = require('./contentEngine');
  const basicCards    = await contentEngine.getBasicCards();
  if (!basicCards.length) return null;

  // Seleção determinística pelo dia (não aleatória — permite reprodução)
  const dayNum  = new Date(dateStr).getTime();
  const card    = basicCards[Math.abs(Math.round(dayNum / 86400000)) % basicCards.length];

  const ritual = {
    date:            dateStr,
    cardTitle:       card.title,
    cardText:        card.text || '',
    cardType:        card.type || 'Ritual',
    challengeType:   'group',
    bonusXp:         50,
    completionCount: 0,
    expiresAt:       _endOfDayUTC(dateStr),
    createdAt:       new Date(),
  };

  await db.collection('daily_ritual').doc(dateStr).set(ritual);
  logger.info({ dateStr, cardTitle: card.title }, 'daily_ritual_generated');
  return ritual;
}

// ── Deck integration ──────────────────────────────────────────────────────────

async function getLivePackIds() {
  const [season, events] = await Promise.all([getActiveSeason(), getActiveEvents()]);
  const ids = new Set();
  (season?.packIds || []).forEach(id => ids.add(id));
  for (const e of events) if (e.bonusCardPackId) ids.add(e.bonusCardPackId);
  return [...ids];
}

// ── Session.ended listener ────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');
  events.on('session.ended', async ({ payload }) => {
    const { roomId, summary, players } = payload || {};
    if (!roomId || !summary) return;

    const ritual = await getDailyRitual().catch(() => null);
    if (!ritual) return;

    const played = (summary.cardCounts?.[ritual.cardTitle] || 0) > 0;
    if (!played) return;

    const db = getDb();
    if (!db) return;

    const authedUids = (players || []).map(p => p.userId).filter(Boolean);

    await db.collection('daily_ritual').doc(ritual.date).update({
      completionCount: admin.firestore.FieldValue.increment(1),
    }).catch(() => {});

    // Invalida cache do dia para refletir completionCount atualizado
    _dailyCache = null;

    events.emit('live.daily_ritual_completed', {
      roomId, date: ritual.date, cardTitle: ritual.cardTitle,
      authedUids, playerCount: authedUids.length,
    });

    logger.info({ roomId, date: ritual.date, cardTitle: ritual.cardTitle },
      'daily_ritual_completed');
  });

  // Pre-aquece o ritual do dia no startup
  getDailyRitual().catch(() => {});

  logger.info({}, 'live_service_initialized');
}

// ── Cache invalidation ────────────────────────────────────────────────────────

function invalidate(what = 'all') {
  if (what === 'season' || what === 'all') _seasonCache = null;
  if (what === 'events' || what === 'all') _eventsCache = null;
  if (what === 'daily'  || what === 'all') _dailyCache  = null;
}

module.exports = {
  getActiveSeason, getActiveEvents, getDailyRitual,
  getLivePackIds, init, invalidate,
};
