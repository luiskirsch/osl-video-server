'use strict';

/**
 * services/sessionDna.js — Session DNA
 *
 * Agrega dados de todas as sessões de uma sala em um perfil de grupo
 * persistente (salas/{roomId}/meta/dna). Atualizado incrementalmente
 * após cada sessão encerrada via EventBus.
 *
 * O DNA alimenta o Adaptive Ritual Engine (P3), que ajusta o conteúdo
 * ao comportamento real do grupo.
 *
 * Estrutura do doc DNA:
 * {
 *   roomId, updatedAt, lastSessionId, lastPlayedAt,
 *   sessionCount, totalCardsRevealed, totalDurationSec, totalVotes,
 *   avgCardsPerSession, avgDurationSec,
 *   cardTypeCounts: { [type]: number },
 *   cardCounts:     { [title]: number },
 *   topCards:       [{ title, count }],   // top 10
 *   emojiTally:     { [emoji]: number },
 *   topReactors:    [{ nickname, count }], // top 5
 *   playDayOfWeek:  { [0-6]: number },
 *   playHourOfDay:  { [0-23]: number },
 * }
 */

const logger = require('../logger');
const events = require('./events');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  events.on('session.ended', async ({ payload }) => {
    const { roomId, sessionId, summary } = payload || {};
    if (!roomId || !sessionId || !summary) return;
    await _updateDna(roomId, sessionId, summary).catch(err =>
      logger.error({ err, roomId, sessionId }, 'session_dna_update_failed')
    );
  });

  logger.info({}, 'session_dna_initialized');
}

// ── DNA computation ───────────────────────────────────────────────────────────

async function _updateDna(roomId, sessionId, summary) {
  const db = getDb();
  if (!db) return;

  const dnaRef = db.collection('salas').doc(roomId).collection('meta').doc('dna');
  const snap   = await dnaRef.get();
  const prev   = snap.exists ? snap.data() : {};

  const now        = new Date();
  const dayOfWeek  = String(now.getDay());
  const hourOfDay  = String(now.getHours());

  // ── Contadores acumulativos ───────────────────────────────────────────────
  const sessionCount       = (prev.sessionCount       || 0) + 1;
  const totalCardsRevealed = (prev.totalCardsRevealed || 0) + (summary.cardsRevealed || 0);
  const totalDurationSec   = (prev.totalDurationSec   || 0) + (summary.durationSec   || 0);
  const totalVotes         = (prev.totalVotes         || 0) + (summary.votesTotal     || 0);

  // ── Distribuição de tipos de carta ───────────────────────────────────────
  const cardTypeCounts = { ...(prev.cardTypeCounts || {}) };
  for (const [type, count] of Object.entries(summary.cardTypeCounts || {})) {
    cardTypeCounts[type] = (cardTypeCounts[type] || 0) + count;
  }

  // ── Contagem por título de carta ─────────────────────────────────────────
  const cardCounts = { ...(prev.cardCounts || {}) };
  for (const [title, count] of Object.entries(summary.cardCounts || {})) {
    cardCounts[title] = (cardCounts[title] || 0) + count;
  }

  const topCards = Object.entries(cardCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, count]) => ({ title, count }));

  // ── Emoji tally ───────────────────────────────────────────────────────────
  const emojiTally = { ...(prev.emojiTally || {}) };
  for (const [emoji, count] of Object.entries(summary.emojiTally || {})) {
    emojiTally[emoji] = (emojiTally[emoji] || 0) + count;
  }

  // ── Top reatores (por nickname — uid não disponível no topReactor) ────────
  const reactorMap = {};
  for (const r of (prev.topReactors || [])) {
    reactorMap[r.nickname] = r.count;
  }
  if (summary.topReactor?.nickname) {
    const { nickname, count } = summary.topReactor;
    reactorMap[nickname] = (reactorMap[nickname] || 0) + count;
  }
  const topReactors = Object.entries(reactorMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nickname, count]) => ({ nickname, count }));

  // ── Padrões temporais ─────────────────────────────────────────────────────
  const playDayOfWeek = { ...(prev.playDayOfWeek || {}) };
  playDayOfWeek[dayOfWeek] = (playDayOfWeek[dayOfWeek] || 0) + 1;

  const playHourOfDay = { ...(prev.playHourOfDay || {}) };
  playHourOfDay[hourOfDay] = (playHourOfDay[hourOfDay] || 0) + 1;

  // ── Montar e persistir ────────────────────────────────────────────────────
  const dna = {
    roomId,
    updatedAt:        now,
    lastSessionId:    sessionId,
    lastPlayedAt:     now,
    sessionCount,
    totalCardsRevealed,
    totalDurationSec,
    totalVotes,
    avgCardsPerSession: sessionCount > 0
      ? Math.round((totalCardsRevealed / sessionCount) * 10) / 10
      : 0,
    avgDurationSec: sessionCount > 0
      ? Math.round(totalDurationSec / sessionCount)
      : 0,
    cardTypeCounts,
    cardCounts,
    topCards,
    emojiTally,
    topReactors,
    playDayOfWeek,
    playHourOfDay,
  };

  await dnaRef.set(dna);
  logger.info({ roomId, sessionId, sessionCount }, 'session_dna_updated');
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getRoomDna(roomId) {
  const db = getDb();
  if (!db) return null;
  const snap = await db
    .collection('salas').doc(roomId)
    .collection('meta').doc('dna')
    .get();
  return snap.exists ? snap.data() : null;
}

module.exports = { init, getRoomDna };
