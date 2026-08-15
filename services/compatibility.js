'use strict';

/**
 * services/compatibility.js — Compatibilidade multi-dimensional entre jogadores
 *
 * Saída canônica:
 *   {
 *     overall:    0.84,          // média ponderada das dimensões
 *     dimensions: {
 *       intensity:      0.91,    // cosine(intensidade_A, intensidade_B)
 *       depth:          0.73,    // profundidade (revelacao/reflexao)
 *       humor:          0.88,    // emojis de risada / total reações
 *       confrontation:  0.67,    // tensao/desafio
 *       participation:  0.94,    // reações por carta revelada
 *       pacing:         0.79,    // ritmo (scalar proximity)
 *     },
 *     confidence:     0.61,      // 0=sem evidência, 1=muito dados
 *     sharedSessions: 8,
 *     label:         'cúmplices',
 *     styleA: {...}, styleB: {...}  // vetores brutos para debug/GameOps
 *   }
 *
 * confidence é CRÍTICO: 0.91 com confidence=0.05 ≠ 0.91 com confidence=0.90.
 * Sistemas downstream devem usar confidence antes de tomar decisão.
 *
 * Armazenamento: users/{uid}.playStyle  (EMA ALPHA=0.20, atualizado em session.ended)
 */

const logger = require('../logger');

const ALPHA          = 0.20;
const HALF_LIFE_DAYS = 30; // meia-vida do playStyle em dias (decay temporal)
const FLAG           = 'compatibility_v1';

// Emojis de risada (parcial — não exaustivo)
const LAUGH_EMOJI = new Set(['😂','🤣','😄','😆','😅','😁','😀','haha','kkk','rsrs','lol']);

const LABELS = [
  { min: 85, label: 'almas gêmeas'  },
  { min: 70, label: 'cúmplices'     },
  { min: 50, label: 'companheiros'  },
  { min: 30, label: 'conhecidos'    },
  { min:  0, label: 'desconhecidos' },
];

const DIM_WEIGHTS = {
  intensity:     0.20,
  depth:         0.20,
  humor:         0.15,
  confrontation: 0.15,
  participation: 0.15,
  pacing:        0.15,
};

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Matemática ─────────────────────────────────────────────────────────────────

// Cosine similarity escalar (1D): dois números
function _scalarSim(a, b) {
  const magA = Math.abs(a);
  const magB = Math.abs(b);
  if (!magA || !magB) return 0.5;
  return Math.max(0, Math.min(1, (a * b) / (magA * magB)));
}

// Proximidade escalar: 1 - |a - b|
function _proximity(a, b) {
  return Math.max(0, 1 - Math.abs((a || 0) - (b || 0)));
}

function _label(score) {
  return LABELS.find(l => score >= l.min)?.label ?? 'desconhecidos';
}

// ── Confidence ────────────────────────────────────────────────────────────────
//
// confidence mede QUANTO evidência existe para o score calculado.
// Nunca alcança 1.0 — sempre há incerteza residual.
//
// Componentes:
//   styleConf  — qualidade do vetor playStyle de cada jogador
//                (depende do nº de sessões individuais)
//   sharedConf — evidência direta de jogar juntos

function _confidence(sessionsA = 0, sessionsB = 0, sharedSessions = 0) {
  const confA      = 1 - Math.exp(-sessionsA      / 10); // 10 sessões = ~63%
  const confB      = 1 - Math.exp(-sessionsB      / 10);
  const styleConf  = (confA + confB) / 2;
  const sharedConf = 1 - Math.exp(-sharedSessions / 3);  // 3 sessões juntos = ~63%

  return parseFloat((0.50 * styleConf + 0.50 * sharedConf).toFixed(3));
}

// ── Derivação de playStyle a partir de um summary de sessão ───────────────────

function deriveSessionStyle(summary) {
  const cardTypeCounts = summary.cardTypeCounts || {};
  const emojiTally     = summary.emojiTally     || {};
  const totalCards     = Object.values(cardTypeCounts).reduce((s, v) => s + v, 0) || 1;
  const totalReactions = Object.values(emojiTally).reduce((s, v) => s + v, 0) || 0;
  const cardsRevealed  = summary.cardsRevealed || 1;
  const durationSec    = summary.durationSec   || 0;

  const laughCount  = Object.entries(emojiTally)
    .filter(([e]) => LAUGH_EMOJI.has(e))
    .reduce((s, [, v]) => s + v, 0);
  const cardsPerMin = cardsRevealed / Math.max(durationSec / 60, 1);

  return {
    intensidade:  +Math.min(durationSec / 2400, 1).toFixed(4),
    profundidade: +( ((cardTypeCounts['revelacao'] || 0) + (cardTypeCounts['reflexao'] || 0)) / totalCards ).toFixed(4),
    humor:        +( totalReactions > 0 ? Math.min(laughCount / totalReactions, 1) : 0 ).toFixed(4),
    participacao: +Math.min(totalReactions / cardsRevealed / 2, 1).toFixed(4),
    ritmo:        +Math.max(0, 1 - Math.min(cardsPerMin / 4, 1)).toFixed(4),
    conflito:     +( ((cardTypeCounts['tensao'] || 0) + (cardTypeCounts['desafio'] || 0)) / totalCards ).toFixed(4),
  };
}

// Fator de decay exponencial: sessão de hoje = 1.0, 30 dias atrás ≈ 0.5
function _decayFactor(daysSinceUpdate = 0) {
  if (daysSinceUpdate <= 0) return 1.0;
  return Math.exp(-Math.LN2 * daysSinceUpdate / HALF_LIFE_DAYS);
}

function _emaUpdate(existing = {}, session = {}, daysSinceUpdate = 0) {
  const decay   = _decayFactor(daysSinceUpdate);
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(session)]);
  const updated = {};
  for (const k of allKeys) {
    const ex  = (existing[k] ?? session[k] ?? 0) * decay;
    const ses = session[k] ?? 0;
    updated[k] = parseFloat(((1 - ALPHA) * ex + ALPHA * ses).toFixed(4));
  }
  return updated;
}

// ── Compatibilidade entre dois perfis ─────────────────────────────────────────

function computeFromProfiles(styleA, styleB, sessionsA = 0, sessionsB = 0, sharedSessions = 0) {
  const confidence = _confidence(sessionsA, sessionsB, sharedSessions);

  if (!styleA || !styleB) {
    return {
      overall: 50, label: 'desconhecidos', confidence,
      dimensions: { intensity: 50, depth: 50, humor: 50, confrontation: 50, participation: 50, pacing: 50 },
      hasData: false,
    };
  }

  const dimensions = {
    intensity:     Math.round(_scalarSim(styleA.intensidade  || 0, styleB.intensidade  || 0) * 100),
    depth:         Math.round(_scalarSim(styleA.profundidade || 0, styleB.profundidade || 0) * 100),
    humor:         Math.round(_scalarSim(styleA.humor        || 0, styleB.humor        || 0) * 100),
    confrontation: Math.round(_scalarSim(styleA.conflito     || 0, styleB.conflito     || 0) * 100),
    participation: Math.round(_scalarSim(styleA.participacao || 0, styleB.participacao || 0) * 100),
    pacing:        Math.round(_proximity(styleA.ritmo        || 0, styleB.ritmo        || 0) * 100),
  };

  const overall = Math.round(
    Object.entries(DIM_WEIGHTS).reduce((sum, [dim, w]) => sum + (dimensions[dim] || 50) * w, 0)
  );

  return {
    overall,
    dimensions,
    confidence,
    label: _label(overall),
    hasData: true,
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

async function computeCompatibility(uid_a, uid_b) {
  const db = getDb();
  if (!db) return null;

  const a_key = uid_a < uid_b ? uid_a : uid_b;
  const b_key = uid_a < uid_b ? uid_b : uid_a;

  const [connSnap, userSnaps] = await Promise.all([
    db.collection('social_connections').doc(`${a_key}_${b_key}`).get().catch(() => null),
    db.getAll(
      db.collection('users').doc(uid_a),
      db.collection('users').doc(uid_b),
    ).catch(() => []),
  ]);

  const dataA          = userSnaps[0]?.exists ? userSnaps[0].data() : {};
  const dataB          = userSnaps[1]?.exists ? userSnaps[1].data() : {};
  const sessionsA      = dataA.reputation?.totalSessions || 0;
  const sessionsB      = dataB.reputation?.totalSessions || 0;
  const sharedSessions = connSnap?.exists ? (connSnap.data().sharedSessions || 0) : 0;

  return {
    ...computeFromProfiles(
      dataA.playStyle || null,
      dataB.playStyle || null,
      sessionsA, sessionsB, sharedSessions,
    ),
    sharedSessions,
    styleA: dataA.playStyle || null,
    styleB: dataB.playStyle || null,
  };
}

async function getGroupCompatibility(uids = []) {
  if (uids.length < 2) return {};
  const pairs = {};
  const tasks = [];
  for (let i = 0; i < uids.length; i++) {
    for (let j = i + 1; j < uids.length; j++) {
      const key = `${uids[i]}_${uids[j]}`;
      tasks.push(
        computeCompatibility(uids[i], uids[j])
          .then(r  => { pairs[key] = r;    })
          .catch(() => { pairs[key] = null; })
      );
    }
  }
  await Promise.all(tasks);
  return pairs;
}

// ── Init: atualiza playStyle após cada sessão ──────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  events.on('session.ended', async ({ payload }) => {
    const { summary, players } = payload || {};
    if (!summary || !Array.isArray(players)) return;

    const authedUids = [...new Set(players.map(p => p.userId).filter(Boolean))];
    if (!authedUids.length) return;

    const db = getDb();
    if (!db) return;

    const sessionStyle = deriveSessionStyle(summary);
    const refs  = authedUids.slice(0, 20).map(uid => db.collection('users').doc(uid));
    const snaps = await db.getAll(...refs).catch(() => []);

    await Promise.all(snaps.map(async (snap) => {
      if (!snap?.exists) return;
      const data       = snap.data();
      const existing   = data.playStyle || {};
      const updatedAt  = data.playStyleUpdatedAt;
      const lastDate   = updatedAt instanceof Date
        ? updatedAt
        : updatedAt?.toDate?.() ?? null;
      const daysSince  = lastDate
        ? (Date.now() - lastDate.getTime()) / 86400000
        : 0;
      const updated    = _emaUpdate(existing, sessionStyle, daysSince);
      try {
        await db.collection('users').doc(snap.id).update({
          playStyle:          updated,
          playStyleUpdatedAt: new Date(),
        });
      } catch (_) {}
    }));

    logger.info({ count: authedUids.length }, 'play_style_updated');
  });

  logger.info('compatibility_initialized');
}

module.exports = {
  computeCompatibility,
  getGroupCompatibility,
  computeFromProfiles,
  deriveSessionStyle,
  init,
};
