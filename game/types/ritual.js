'use strict';

/**
 * game/types/ritual.js — RitualGameDefinition
 *
 * Lógica pura do tipo de jogo "Ritual": construção de deck, preparação de
 * cartas/efeitos, sanitização de cartas customizadas e cálculo de summary.
 * Sem dependências de Firestore, Express ou auth.
 *
 * Implementa a interface GameDefinition consumida por game/engine.js.
 */

const crypto = require('crypto');

function cryptoShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const idx = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
    [a[i], a[idx]] = [a[idx], a[i]];
  }
  return a;
}

function pickRandom(arr) {
  if (!arr?.length) return null;
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

function prepareEffect(effect, players) {
  if (!effect) return null;
  const base = {
    id:       crypto.randomBytes(6).toString('hex'),
    type:     effect.type,
    phase:    effect.phase || 'battlecry',
    label:    effect.label || null,
    params:   {},
    votes:    {},
    resolved: false,
  };
  switch (effect.type) {
    case 'force_player': {
      if (effect.target === 'two_random') {
        const shuffled = cryptoShuffle(players.filter(p => p.id));
        const t1 = shuffled[0], t2 = shuffled[1] || shuffled[0];
        base.params = {
          targetId:    t1?.id   || '', targetName:  t1?.name  || 'Jogador',
          targetId2:   t2?.id   || t1?.id   || '',
          targetName2: t2?.name || t1?.name || 'Jogador',
        };
      } else {
        const t = pickRandom(players.length > 1 ? players : players);
        base.params = { targetId: t?.id || '', targetName: t?.name || 'Jogador' };
      }
      break;
    }
    case 'set_timer':  { base.params = { duration: effect.duration || 60, startedAt: Date.now() }; break; }
    case 'vote':       { base.params = { question: effect.question || 'Vote:', options: effect.options || players.map(p => p.name || 'Jogador') }; break; }
    case 'next_category':
    case 'chain_card': { base.params = { category: effect.category || '' }; break; }
    case 'give_xp':    { base.params = { amount: effect.amount || 10 }; break; }
  }
  return base;
}

// ── Interface GameDefinition ──────────────────────────────────────────────────

module.exports = {
  id: 'ritual',

  /**
   * Monta e embaralha o deck a partir de conteúdo já resolvido pela infra.
   * @param {{ basicCards: object[], packCards: object[], customContributions: object[] }} params
   * @returns {{ deck: object[] }}
   */
  buildDeck({ basicCards = [], packCards = [], customContributions = [] }) {
    if (customContributions.length > 0) {
      const seen = new Set();
      return {
        deck: cryptoShuffle(
          [...basicCards, ...customContributions].filter(c => {
            if (seen.has(c.title)) return false;
            seen.add(c.title);
            return true;
          })
        ),
      };
    }
    return { deck: cryptoShuffle([...basicCards, ...packCards]) };
  },

  /**
   * Prepara uma carta para exibição: resolve efeitos e targeta jogadores.
   * @param {object} card
   * @param {object[]} players
   * @param {object} effectsMap  { [title]: { battlecry?, deathrattle? } }
   * @returns {{ battlecry: object|null, deathrattle: object|null }}
   */
  prepareCard(card, players, effectsMap = {}) {
    if (!card) return { battlecry: null, deathrattle: null };
    const key     = card._origTitle || card.title;
    const effects = card.effects || effectsMap[key] || {};
    return {
      battlecry:   effects.battlecry   ? prepareEffect({ ...effects.battlecry,   phase: 'battlecry' },   players) : null,
      deathrattle: effects.deathrattle ? prepareEffect({ ...effects.deathrattle, phase: 'deathrattle' }, players) : null,
    };
  },

  /**
   * Sanitiza uma carta fornecida pelo jogador (deck customizado).
   * Retorna null para entradas inválidas.
   */
  sanitizeCard(c) {
    if (!c || typeof c !== 'object') return null;
    return {
      title:      String(c.title      || '').slice(0, 200),
      type:       String(c.type       || 'Ritual').slice(0, 50),
      text:       String(c.text       || '').slice(0, 2000),
      rule:       c.rule      ? String(c.rule).slice(0, 1000)      : undefined,
      subrule:    c.subrule   ? String(c.subrule).slice(0, 1000)   : undefined,
      phrase:     c.phrase    ? String(c.phrase).slice(0, 500)     : undefined,
      _origTitle: c._origTitle ? String(c._origTitle).slice(0, 200) : undefined,
    };
  },

  /**
   * Computa o summary durável de uma sessão a partir dos eventos.
   * @param {object[]} events  Dados brutos dos eventos (não Firestore docs)
   * @param {{ players?: object[], createdMs?: number }} ctx
   * @returns {object} summary
   */
  computeSummary(events = [], { players = [], createdMs = Date.now() } = {}) {
    const durationSec      = Math.round((Date.now() - createdMs) / 1000);
    const reactionsByActor = {};
    const emojiTally       = {};
    let cardsRevealed = 0, votesTotal = 0, missionsCompleted = 0;

    for (const e of events) {
      if (e.type === 'CARD_REVEALED')     cardsRevealed++;
      if (e.type === 'VOTE_CAST')         votesTotal++;
      if (e.type === 'MISSION_COMPLETED') missionsCompleted++;
      if (e.type === 'REACTION_SENT') {
        if (e.actor) reactionsByActor[e.actor] = (reactionsByActor[e.actor] || 0) + 1;
        const emoji = e.payload?.emoji;
        if (emoji) emojiTally[emoji] = (emojiTally[emoji] || 0) + 1;
      }
    }

    const topReactorEntry = Object.entries(reactionsByActor).sort((a, b) => b[1] - a[1])[0];
    let topReactor = null;
    if (topReactorEntry) {
      const [uid, count] = topReactorEntry;
      const match = players.find(p => p.userId === uid || p.playerId === uid);
      if (match) topReactor = { nickname: match.nickname, count };
    }

    return {
      cardsRevealed, durationSec, topReactor, emojiTally,
      votesTotal, missionsCompleted, playerCount: players.length,
    };
  },
};
