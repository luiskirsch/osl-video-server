'use strict';

/**
 * services/contextualSelection.js — Seleção de conteúdo por contexto presente
 *
 * Pipeline explícito (pré-sessão):
 *   DECK (Adaptive Engine) → eligibility → hard constraints →
 *   context scoring → novelty → ranking → prime deck
 *
 * Shadow Mode (feature flag OFF):
 *   Pipeline sempre executa. Se flag desabilitado, o deck ORIGINAL é retornado,
 *   mas o resultado do pipeline é emitido como engine.contextual_selection_shadow.
 *   Isso permite coletar evidência antes de ativar para produção.
 *
 * Confidence com autoridade operacional:
 *   Sinais baseados em playStyle do host são escalados pela confiança
 *   (derivada de totalSessions). Pouca evidência → influência mínima.
 *
 *   < 0.20  → sinal ignorado      (escala 0.00)
 *   < 0.50  → influência mínima   (escala 0.25)
 *   < 0.75  → influência normal   (escala 0.75)
 *   ≥ 0.75  → influência plena    (escala 1.00)
 *
 * Explainability:
 *   reasons[] = [{ factor, contribution }] — contribuição numérica por fator
 *   Emitido em engine.contextual_selection_applied / _shadow para GameOps.
 */

const { randomUUID } = require('crypto');
const logger = require('../logger');

const FLAG         = 'contextual_selection_v1';
const PRIME_SLOTS  = 3;
const ABSENCE_DAYS = 14;
const NOVELTY_CAP  = 5; // cartas vistas ≥ N vezes ganham penalidade de novidade

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

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

function _pick(pool, seed) {
  return { ...pool[seed % pool.length], _contextual: true };
}

// ── Rank correlation (Spearman) ───────────────────────────────────────────────
//
// Mede a intensidade da divergência entre dois rankings (legacyTop5 vs shadowTop5).
// Items ausentes em uma lista recebem rank = len + 1 (penalidade de ausência).
// Retorna -1..1: 1 = idêntico, 0 = sem correlação, -1 = inversão total.

function _spearman(a, b) {
  const all = [...new Set([...a, ...b])];
  const n   = all.length;
  if (n < 2) return 1.0;
  const rA = item => { const i = a.indexOf(item); return i >= 0 ? i + 1 : a.length + 1; };
  const rB = item => { const i = b.indexOf(item); return i >= 0 ? i + 1 : b.length + 1; };
  const d2  = all.reduce((s, item) => s + (rA(item) - rB(item)) ** 2, 0);
  return parseFloat((1 - (6 * d2) / (n * (n * n - 1))).toFixed(3));
}

// ── Confidence authority ───────────────────────────────────────────────────────
//
// Escala com que sinais baseados em aprendizado histórico (playStyle) influenciam
// a seleção. Sinais temporais e de grupo são sempre aplicados em escala plena —
// eles dependem de fatos objetivos (hora, tamanho do grupo), não de inferência.

function _confidenceScale(totalSessions = 0) {
  const conf = 1 - Math.exp(-totalSessions / 10); // ~63% em 10 sessões
  if (conf < 0.20) return 0;     // ignorar sinal: dado insuficiente
  if (conf < 0.50) return 0.25;  // influência mínima
  if (conf < 0.75) return 0.75;  // influência normal
  return 1.0;                    // influência plena
}

// ── 1. Eligibility ─────────────────────────────────────────────────────────────

function _isEligible(card) {
  return !!(card && typeof card === 'object' && card.title?.trim?.());
}

// ── 2. Hard Constraints ────────────────────────────────────────────────────────

function _hardConstraint(card, { groupSize, mode }) {
  const minPlayers = card.minPlayers || 1;
  if (groupSize < minPlayers) return `min_players_${minPlayers}`;

  if (card.modes?.length && !card.modes.includes(mode || 'ritual')) {
    return `mode_mismatch_${mode}`;
  }
  return null;
}

// ── 3. Context Scoring ─────────────────────────────────────────────────────────
//
// Retorna { delta, reasons: [{factor, contribution}] }
// Sinais temporais e de grupo: escala plena
// Sinais de playStyle do host: escala pela confidence (totalSessions)

function _contextScore(card, context) {
  const { player, temporal, groupSize = 1, world } = context || {};
  const hour      = temporal?.hourBrazil ?? 12;
  const weekday   = temporal?.dayOfWeek  ?? 3;
  const type      = (card.type      || '').toLowerCase();
  const intens    = (card.intensity || 'medium').toLowerCase();

  const styleScale = _confidenceScale(player?.totalSessions ?? 0);

  let delta   = 0;
  const reasons = []; // { factor, contribution }

  function add(contribution, factor) {
    delta += contribution;
    if (Math.abs(contribution) >= 0.01) reasons.push({ factor, contribution: +contribution.toFixed(3) });
  }

  // ── Temporal (escala plena — fato objetivo) ────────────────────────────────

  if (hour >= 6 && hour < 12) {
    if (intens === 'light') add( 0.30, 'morning_light_match');
    if (intens === 'deep')  add(-0.20, 'morning_deep_penalty');
  } else if (hour >= 21 || hour < 4) {
    if (intens === 'deep')  add( 0.25, 'late_depth_match');
    if (type.includes('revelacao') || type.includes('reflexao')) add(0.20, 'late_revelation_match');
  }

  if (weekday === 0 || weekday === 6) {
    if (type.includes('desafio')) add(0.15, 'weekend_challenge');
    if (intens === 'light')       add(0.10, 'weekend_light');
  }

  // ── Grupo (escala plena) ───────────────────────────────────────────────────

  if (groupSize <= 2) {
    if (type.includes('conexao') || type.includes('revelacao')) add( 0.30, 'duo_intimacy_match');
    if (type.includes('desafio') || type.includes('tensao'))    add(-0.15, 'duo_tension_penalty');
  } else if (groupSize >= 5) {
    if (type.includes('desafio') || type.includes('conexao'))   add( 0.25, 'large_group_energy');
    if (intens === 'light')                                     add( 0.10, 'large_group_light');
  }

  // ── Primeira sessão (escala plena — fato objetivo) ────────────────────────

  if (player?.isFirstSession) {
    if (intens === 'light')                                            add( 0.40, 'first_session_light');
    if (intens === 'deep')                                             add(-0.30, 'first_session_deep_penalty');
    if (type.includes('tensao') || type.includes('conflito'))          add(-0.20, 'first_session_conflict_penalty');
  }

  // ── playStyle do host (confidence-scaled) ─────────────────────────────────

  const style = player?.playStyle;
  if (style && styleScale > 0) {
    if (style.profundidade > 0.6
        && (type.includes('revelacao') || type.includes('reflexao')))
      add(0.15 * styleScale, 'host_depth_preference');

    if (style.intensidade < 0.4 && intens === 'light')
      add(0.15 * styleScale, 'host_light_preference');

    if (style.intensidade > 0.7 && (intens === 'deep' || type.includes('desafio')))
      add(0.15 * styleScale, 'host_intensity_preference');

    if (style.humor > 0.6 && (type.includes('desafio') || intens === 'light'))
      add(0.10 * styleScale, 'host_humor_preference');
  }

  // ── World (escala plena) ───────────────────────────────────────────────────

  if ((world?.communityProgress ?? 0) >= 0.85) {
    if (type.includes('comunidade') || type.includes('conexao')) add(0.20, 'world_mission_climax');
  }

  return { delta, reasons };
}

// ── 4. Novelty ────────────────────────────────────────────────────────────────

function _noveltyScore(card, dna) {
  if (!dna?.cardCounts) return { contribution: 0, factor: null };
  const count = dna.cardCounts[card.title] || 0;
  if (count === 0)            return { contribution:  0.15, factor: 'novelty_bonus'      };
  if (count >= NOVELTY_CAP)   return { contribution: -0.20, factor: 'overplayed_penalty'  };
  return { contribution: -(count * 0.04), factor: `seen_${count}x_penalty` };
}

// ── Pipeline interno ──────────────────────────────────────────────────────────

function _runPipeline(deck, context) {
  const dna       = context.group?.dna || null;
  const seed      = Math.floor(Date.now() / 86400000);
  const mode      = context.mode    || 'ritual';
  const groupSize = context.groupSize || 1;

  // Carta de abertura especial
  let starter     = null;
  let starterTitle = null;
  const daysSince = context.player?.daysSinceLast ?? null;

  if (context.player?.isFirstSession) {
    starter = _pick(STARTERS.first_session, seed);
  } else if (daysSince !== null && daysSince >= ABSENCE_DAYS) {
    starter = _pick(STARTERS.reunion, seed);
  } else if ((context.world?.communityProgress ?? 0) >= 0.90 && context.world?.currentMission) {
    starter = _pick(STARTERS.mission_climax, seed);
  }
  if (starter) starterTitle = starter.title;

  // Pipeline nos primeiros WINDOW cards
  const WINDOW   = Math.min(12, deck.length);
  const scored   = [];
  const excluded = new Set();

  for (let i = 0; i < WINDOW; i++) {
    const card = deck[i];
    if (!_isEligible(card))                           { excluded.add(i); continue; }
    const fail = _hardConstraint(card, { groupSize, mode });
    if (fail)                                         { excluded.add(i); continue; }

    const { delta: ctxDelta, reasons: ctxReasons } = _contextScore(card, context);
    const { contribution: novC, factor: novF }      = _noveltyScore(card, dna);

    const reasons = [...ctxReasons];
    if (novF) reasons.push({ factor: novF, contribution: +novC.toFixed(3) });

    scored.push({ card, idx: i, score: 1.0 + ctxDelta + novC, reasons });
  }

  const promoted    = scored.sort((a, b) => b.score - a.score).slice(0, PRIME_SLOTS);
  const promotedIdx = new Set(promoted.map(p => p.idx));

  const primed = [
    ...promoted.sort((a, b) => b.score - a.score).map(p => p.card),
    ...deck.filter((_, i) => !promotedIdx.has(i) && !excluded.has(i)),
    ...Array.from(excluded).sort((a, b) => a - b).map(i => deck[i]),
  ];
  if (starter) primed.unshift(starter);

  const selections = promoted.map(p => ({
    title:   p.card.title,
    score:   +p.score.toFixed(3),
    reasons: p.reasons,
  }));

  return { primed, selections, starterTitle };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Aplica priming contextual (ou shadow) ao deck.
 *
 * Sempre executa o pipeline. Se feature flag OFF → shadow mode:
 *   deck original retornado, decisão registrada em engine.contextual_selection_shadow.
 * Se flag ON → deck primed retornado + engine.contextual_selection_applied emitido.
 */
async function applyPriming(deck, context, { roomId, hostUid } = {}) {
  if (!deck?.length || !context) return deck;

  // Executa pipeline independente do flag (shadow mode depende disso)
  let result;
  try {
    result = _runPipeline(deck, context);
  } catch (err) {
    logger.warn({ err: err.message, roomId }, 'contextual_selection_pipeline_error');
    return deck;
  }

  // ID estável para correlacionar o registro de audit com outcomes futuros
  const auditId = randomUUID();

  // Confiança bruta nos sinais inferidos (0–1, nunca alcança 1)
  const rawConf = parseFloat((1 - Math.exp(-(context.player?.totalSessions ?? 0) / 10)).toFixed(3));

  // Feature flag determina se aplica ou apenas observa
  let enabled = false;
  try {
    const featureFlags = require('./featureFlags');
    enabled = await featureFlags.isEnabled(FLAG, hostUid || null).catch(() => false);
  } catch (_) {}

  const events = require('./events');

  if (!enabled) {
    // Shadow mode: emite o que TERIA acontecido, sem alterar o deck real
    const legacyTop5      = deck.slice(0, 5).map(c => c.title);
    const shadowTop5      = result.primed.slice(0, 5).map(c => c.title);
    const wouldDiffer     = result.primed[0]?.title !== deck[0]?.title || !!result.starterTitle;
    const rankCorrelation = _spearman(legacyTop5, shadowTop5);

    events.emit('engine.contextual_selection_shadow', {
      auditId, roomId, hostUid,
      groupSize:       context.groupSize,
      mode:            context.mode,
      temporal:        context.temporal,
      confidence:      rawConf,
      legacyTop5,
      shadowTop5,
      rankCorrelation,
      selections:      result.selections,
      starterCard:     result.starterTitle,
      wouldDiffer,
    });

    // Registra auditId na sala para correlação futura com outcomes
    if (roomId) {
      const db = getDb();
      if (db) db.collection('rooms').doc(roomId).update({ lastSelectionAuditId: auditId }).catch(() => {});
    }

    return deck; // deck original — jogador não percebe nada
  }

  // Feature ON: aplica priming e emite
  if (result.selections.length > 0 || result.starterTitle) {
    events.emit('engine.contextual_selection_applied', {
      auditId, roomId, hostUid,
      groupSize:   context.groupSize,
      mode:        context.mode,
      temporal:    context.temporal,
      confidence:  rawConf,
      selections:  result.selections,
      starterCard: result.starterTitle,
    });

    if (roomId) {
      const db = getDb();
      if (db) db.collection('rooms').doc(roomId).update({ lastSelectionAuditId: auditId }).catch(() => {});
    }
  }

  return result.primed;
}

module.exports = { applyPriming, _contextScore, _hardConstraint, _confidenceScale };
