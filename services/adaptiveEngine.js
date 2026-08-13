'use strict';

/**
 * services/adaptiveEngine.js — Adaptive Ritual Engine (P3)
 *
 * Reordena o deck usando o DNA histórico do grupo para que cartas mais
 * relevantes apareçam primeiro — sem perder a aleatoriedade que torna
 * cada sessão única.
 *
 * Algoritmo de pontuação por carta:
 *   1. Afinidade de tipo   — multiplica se o grupo joga esse tipo mais
 *   2. Novidade            — penaliza cartas já muito vistas pelo grupo
 *   3. Intensidade         — ajusta ao nível de engajamento histórico
 *   4. Jitter ±15%         — mantém variedade entre sessões
 *
 * Ativa via feature flag `adaptive_ritual_engine`. Requer ≥3 sessões
 * de DNA para ter sinal confiável; abaixo disso retorna deck original.
 *
 * API:
 *   reorderDeck(deck, { roomId, hostUid })  → deck reordenado (ou original)
 *   isEnabled(uid?)                         → boolean
 */

const featureFlags = require('./featureFlags');
const sessionDna   = require('./sessionDna');
const events       = require('./events');
const logger       = require('../logger');

const FLAG             = 'adaptive_ritual_engine';
const MIN_SESSIONS     = 3;    // DNA precisa de pelo menos N sessões
const MIN_CARDS_TYPED  = 5;    // mínimo de cartas para calcular afinidade de tipo

// ── API pública ───────────────────────────────────────────────────────────────

async function isEnabled(uid = null) {
  return featureFlags.isEnabled(FLAG, uid).catch(() => false);
}

/**
 * Reordena o deck com base no DNA do grupo.
 * Em caso de erro ou dados insuficientes, retorna o deck original intacto.
 *
 * @param {object[]} deck   cartas do deck puro (já shuffleadas)
 * @param {{ roomId: string, hostUid: string|null }} opts
 * @returns {Promise<object[]>}
 */
async function reorderDeck(deck, { roomId, hostUid = null } = {}) {
  if (!deck?.length || !roomId) return deck;

  try {
    const enabled = await isEnabled(hostUid);
    if (!enabled) return deck;

    const dna = await sessionDna.getRoomDna(roomId);
    if (!dna || (dna.sessionCount || 0) < MIN_SESSIONS) return deck;

    const scored = deck.map(card => ({
      card,
      score: _scoreCard(card, dna),
    }));
    scored.sort((a, b) => b.score - a.score);

    const reordered = scored.map(s => s.card);

    events.emit('engine.adaptive_applied', {
      roomId,
      deckSize:     deck.length,
      sessionCount: dna.sessionCount,
      topCardType:  Object.entries(dna.cardTypeCounts || {})
        .sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    });

    logger.info({ roomId, deckSize: deck.length, sessionCount: dna.sessionCount },
      'adaptive_ritual_engine_applied');

    return reordered;
  } catch (err) {
    logger.warn({ err, roomId }, 'adaptive_engine_error_fallback');
    return deck;   // sempre seguro — jamais quebra o jogo
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function _scoreCard(card, dna) {
  let score = 1.0;

  // ── 1. Afinidade de tipo ─────────────────────────────────────────────────
  // Multiplica [1.0, 2.0] proporcional ao percentual desse tipo na história
  const totalByType = Object.values(dna.cardTypeCounts || {})
    .reduce((s, n) => s + n, 0);
  if (totalByType >= MIN_CARDS_TYPED) {
    const typePct = (dna.cardTypeCounts?.[card.type] || 0) / totalByType;
    score *= 1 + typePct;
  }

  // ── 2. Novidade ──────────────────────────────────────────────────────────
  // Penaliza cartas que o grupo já viu muitas vezes; threshold = 2× média
  const playCount    = dna.cardCounts?.[card.title] || 0;
  const threshold    = (dna.avgCardsPerSession || 10) * 2;
  const noveltyMult  = Math.max(0.05, 1 - playCount / threshold);
  score *= noveltyMult;

  // ── 3. Intensidade ───────────────────────────────────────────────────────
  // Proxy de engajamento: reações por carta por sessão histórica
  const reactionsPerCard = dna.totalCardsRevealed > 0
    ? (dna.totalReactions || 0) / dna.totalCardsRevealed
    : 0;

  // Grupo muito reativo → favorece cartas high; grupo quieto → favorece low
  const intensityMult = {
    low:    reactionsPerCard < 0.5  ? 1.25 : 0.75,
    medium: 1.0,
    high:   reactionsPerCard > 1.5  ? 1.30 : (reactionsPerCard > 0.8 ? 1.10 : 0.70),
  }[card.intensity || 'medium'] ?? 1.0;
  score *= intensityMult;

  // ── 4. Jitter ±15% ───────────────────────────────────────────────────────
  // Garante que sessões diferentes com o mesmo DNA produzam ordens distintas
  score *= 0.85 + Math.random() * 0.30;

  return score;
}

module.exports = { reorderDeck, isEnabled };
