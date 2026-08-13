'use strict';

/**
 * services/contextualSelection.js — Seleção de conteúdo por contexto presente
 *
 * Pipeline explícito (pré-sessão):
 *
 *   DECK ORDENADO (Adaptive Engine)
 *         ↓
 *   1. eligibility     — carta válida (título, tipo)
 *         ↓
 *   2. hard constraints — minPlayers, modo incompatível
 *         ↓
 *   3. context scoring — temporal + grupo + mundo + estilo host
 *         ↓
 *   4. novelty         — penaliza cartas muito vistas pelo grupo (DNA)
 *         ↓
 *   5. final ranking   — ordena candidatos
 *         ↓
 *   6. prime deck      — promove top PRIME_SLOTS para posições iniciais
 *         ↓
 *   DECK FINAL (+ carta de abertura se contexto pede)
 *
 * Hard constraints são separados de scoring:
 *   uma carta que falha num constraint é excluída da candidatura imediatamente.
 *   uma carta com score baixo permanece no deck — só sai das primeiras posições.
 *
 * Explainability:
 *   cada candidato retorna reasons[] com os fatores que afetaram o score.
 *   emitido via EventBus → GameOps pode auditar "por que esta carta?"
 *
 * Feature flag: contextual_selection_v1
 *   Desabilitado → retorna deck original sem modificação.
 *   Erro interno → fallback silencioso para deck original.
 */

const logger  = require('../logger');

const FLAG       = 'contextual_selection_v1';
const PRIME_SLOTS  = 3;
const ABSENCE_DAYS = 14;
const NOVELTY_WINDOW = 5; // cartas vistas mais de N vezes ganham penalidade de novidade

// Pool de cartas de abertura por situação (ephemeral — não persiste no Firestore)
const STARTERS = {
  reunion: [
    { title: 'Quanto tempo...',    type: 'contexto', text: 'Faz um tempo. Como você está de verdade?' },
    { title: 'De volta',           type: 'contexto', text: 'O grupo está reunido. O que aconteceu enquanto você estava fora?' },
    { title: 'Por onde começar?',  type: 'contexto', text: 'Muito aconteceu. Escolha uma coisa para compartilhar.' },
  ],
  first_session: [
    { title: 'Ponto de partida',   type: 'contexto', text: 'Por que você está aqui agora? O que te trouxe até essa sala?' },
    { title: 'Olá, grupo',         type: 'contexto', text: 'Primeira vez aqui. Quem você é quando ninguém está olhando?' },
  ],
  mission_climax: [
    { title: 'A linha de chegada', type: 'contexto', text: 'A comunidade está quase lá. O que você contribuiu para esse momento?' },
    { title: 'Juntos',             type: 'contexto', text: 'A missão coletiva está quase completa. O que isso significa pra você?' },
  ],
};

function _pickStarter(pool, seed) {
  return { ...pool[seed % pool.length], _contextual: true };
}

// ── 1. Eligibility ─────────────────────────────────────────────────────────────

function _isEligible(card) {
  return !!(card && typeof card === 'object' && card.title && String(card.title).trim().length > 0);
}

// ── 2. Hard Constraints ────────────────────────────────────────────────────────
//
// Retorna null se a carta passa, ou string com o motivo da exclusão.
// Hard constraints não são numéricos — são booleans. Fail = carta sai da candidatura.

function _hardConstraint(card, { groupSize, mode }) {
  // Exige número mínimo de jogadores (campo opcional nas cartas)
  const minPlayers = card.minPlayers || 1;
  if (groupSize < minPlayers) return `min_players_${minPlayers}`;

  // Modo incompatível (e.g., carta marcada como solo-only em sessão de grupo)
  if (card.modes && Array.isArray(card.modes) && card.modes.length > 0) {
    if (!card.modes.includes(mode || 'ritual')) return `mode_mismatch_${mode}`;
  }

  return null; // passa
}

// ── 3. Context Scoring ─────────────────────────────────────────────────────────
//
// Retorna { delta: float, reasons: string[] }
// delta é somado ao score base (1.0)

function _contextScore(card, context) {
  const { player, temporal, groupSize = 1, world } = context || {};
  const hour    = temporal?.hourBrazil ?? 12;
  const weekday = temporal?.dayOfWeek  ?? 3;
  const type    = (card.type      || '').toLowerCase();
  const intens  = (card.intensity || 'medium').toLowerCase();

  let delta   = 0;
  const reasons = [];

  // ── Temporal ─────────────────────────────────────────────────────────────

  if (hour >= 6 && hour < 12) {
    if (intens === 'light')  { delta += 0.30; reasons.push('morning_light_match'); }
    if (intens === 'deep')   { delta -= 0.20; reasons.push('morning_deep_penalty'); }
  } else if (hour >= 21 || hour < 4) {
    if (intens === 'deep')   { delta += 0.25; reasons.push('late_depth_match'); }
    if (type.includes('revelacao') || type.includes('reflexao')) {
      delta += 0.20; reasons.push('late_revelation_match');
    }
  }

  if (weekday === 0 || weekday === 6) {
    if (type.includes('desafio')) { delta += 0.15; reasons.push('weekend_challenge'); }
    if (intens === 'light')       { delta += 0.10; reasons.push('weekend_light'); }
  }

  // ── Grupo ─────────────────────────────────────────────────────────────────

  if (groupSize <= 2) {
    if (type.includes('conexao') || type.includes('revelacao')) {
      delta += 0.30; reasons.push('duo_intimacy_match');
    }
    if (type.includes('desafio') || type.includes('tensao')) {
      delta -= 0.15; reasons.push('duo_tension_penalty');
    }
  } else if (groupSize >= 5) {
    if (type.includes('desafio') || type.includes('conexao')) {
      delta += 0.25; reasons.push('large_group_energy');
    }
    if (intens === 'light') { delta += 0.10; reasons.push('large_group_light'); }
  }

  // ── Primeira sessão ───────────────────────────────────────────────────────

  if (player?.isFirstSession) {
    if (intens === 'light')  { delta += 0.40; reasons.push('first_session_light'); }
    if (intens === 'deep')   { delta -= 0.30; reasons.push('first_session_deep_penalty'); }
    if (type.includes('tensao') || type.includes('conflito')) {
      delta -= 0.20; reasons.push('first_session_conflict_penalty');
    }
  }

  // ── Estilo histórico do host (playStyle) ───────────────────────────────────

  const style = player?.playStyle;
  if (style) {
    if (style.profundidade > 0.6
      && (type.includes('revelacao') || type.includes('reflexao'))) {
      delta += 0.15; reasons.push('host_depth_preference');
    }
    if (style.intensidade < 0.4 && intens === 'light') {
      delta += 0.15; reasons.push('host_light_preference');
    }
    if (style.intensidade > 0.7 && (intens === 'deep' || type.includes('desafio'))) {
      delta += 0.15; reasons.push('host_intensity_preference');
    }
    if (style.humor > 0.6 && (type.includes('desafio') || intens === 'light')) {
      delta += 0.10; reasons.push('host_humor_preference');
    }
  }

  // ── World: missão no clímax ────────────────────────────────────────────────

  if ((world?.communityProgress ?? 0) >= 0.85) {
    if (type.includes('comunidade') || type.includes('conexao')) {
      delta += 0.20; reasons.push('world_mission_climax');
    }
  }

  return { delta, reasons };
}

// ── 4. Novelty ────────────────────────────────────────────────────────────────

function _noveltyScore(card, dna) {
  if (!dna?.cardCounts) return { delta: 0, reason: null };
  const count = dna.cardCounts[card.title] || 0;
  if (count === 0)          return { delta: 0.15,        reason: 'novelty_bonus' };
  if (count >= NOVELTY_WINDOW) return { delta: -0.20,   reason: 'overplayed_penalty' };
  return { delta: -(count * 0.04), reason: `seen_${count}x_penalty` };
}

// ── Pipeline completo ─────────────────────────────────────────────────────────

/**
 * Aplica priming contextual ao deck já ordenado pelo Adaptive Engine.
 *
 * @param {object[]} deck     Deck pós-adaptiveEngine
 * @param {object}   context  Saída de playerContext.buildSessionContext
 * @param {string}   [roomId] Para log de GameOps
 * @returns {object[]}         Deck com priming contextual
 */
async function applyPriming(deck, context, { roomId, hostUid } = {}) {
  if (!deck?.length || !context) return deck;

  try {
    // Feature flag — skip se desabilitado
    const featureFlags = require('./featureFlags');
    const enabled = await featureFlags.isEnabled(FLAG, hostUid || null).catch(() => false);
    if (!enabled) return deck;
  } catch (_) {
    return deck;
  }

  try {
    const dna      = context.group?.dna || null;
    const seed     = Math.floor(Date.now() / 86400000);
    const mode     = context.mode || 'ritual';
    const groupSize = context.groupSize || 1;

    // 1. Carta de abertura especial
    let starter = null;
    const daysSince = context.player?.daysSinceLast ?? null;

    if (context.player?.isFirstSession) {
      starter = _pickStarter(STARTERS.first_session, seed);
    } else if (daysSince !== null && daysSince >= ABSENCE_DAYS) {
      starter = _pickStarter(STARTERS.reunion, seed);
    } else if ((context.world?.communityProgress ?? 0) >= 0.90 && context.world?.currentMission) {
      starter = _pickStarter(STARTERS.mission_climax, seed);
    }

    // 2-5. Pipeline nos primeiros ~12 cards (preserva ordem do Adaptive Engine no restante)
    const WINDOW  = Math.min(12, deck.length);
    const scored  = [];
    const excluded = new Set(); // índices excluídos por hard constraint

    for (let i = 0; i < WINDOW; i++) {
      const card = deck[i];

      if (!_isEligible(card)) { excluded.add(i); continue; }

      const constraint = _hardConstraint(card, { groupSize, mode });
      if (constraint) { excluded.add(i); continue; }

      const { delta: ctxDelta, reasons: ctxReasons } = _contextScore(card, context);
      const { delta: novDelta, reason: novReason }    = _noveltyScore(card, dna);

      const noveltyReasons = novReason ? [novReason] : [];
      const allReasons     = [...ctxReasons, ...noveltyReasons];

      scored.push({
        card,
        idx:     i,
        score:   1.0 + ctxDelta + novDelta,
        reasons: allReasons,
      });
    }

    // 5. Final ranking — top PRIME_SLOTS candidatos
    const promoted    = scored.sort((a, b) => b.score - a.score).slice(0, PRIME_SLOTS);
    const promotedIdx = new Set(promoted.map(p => p.idx));

    // 6. Reconstrói deck: promovidos no topo, restante na ordem original
    const primed = [
      ...promoted.sort((a, b) => b.score - a.score).map(p => p.card),
      ...deck.filter((_, idx) => !promotedIdx.has(idx) && !excluded.has(idx)),
      ...Array.from(excluded).sort().map(idx => deck[idx]), // excluídos no final
    ];

    // Injeta starter em posição 0 (após priming)
    if (starter) primed.unshift(starter);

    // Emite para GameOps (assíncrono, não bloqueia)
    if (promoted.length > 0) {
      const events = require('./events');
      events.emit('engine.contextual_selection_applied', {
        roomId, hostUid, groupSize, mode,
        temporal: context.temporal,
        selections: promoted.map(p => ({
          title:   p.card.title,
          score:   parseFloat(p.score.toFixed(3)),
          reasons: p.reasons,
        })),
        starterInjected: !!starter,
      });
    }

    return primed;

  } catch (err) {
    logger.warn({ err: err.message, roomId }, 'contextual_selection_failed_fallback');
    return deck; // fallback: deck original
  }
}

module.exports = { applyPriming, _contextScore, _hardConstraint };
