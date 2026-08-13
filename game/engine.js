'use strict';

/**
 * game/engine.js — GameEngine
 *
 * Dispatcher plugável que delega operações ao GameDefinition correto.
 * Para adicionar um novo tipo de jogo: criar game/types/<nome>.js,
 * implementar a mesma interface e registrá-lo em DEFINITIONS abaixo.
 *
 * Interface GameDefinition:
 *   id: string
 *   buildDeck({ basicCards, packCards, customContributions }) → { deck }
 *   prepareCard(card, players, effectsMap)                   → { battlecry, deathrattle }
 *   sanitizeCard(c)                                          → card | null
 *   computeSummary(events, { players, createdMs })           → summary
 */

const ritual = require('./types/ritual');

const DEFINITIONS = {
  [ritual.id]: ritual,
};

class GameEngine {
  constructor(type = 'ritual') {
    const def = DEFINITIONS[type];
    if (!def) throw new Error(`UNKNOWN_GAME_TYPE:${type}`);
    this._def = def;
    this.type = type;
  }

  buildDeck(params)                       { return this._def.buildDeck(params); }
  prepareCard(card, players, effectsMap)  { return this._def.prepareCard(card, players, effectsMap); }
  sanitizeCard(c)                         { return this._def.sanitizeCard(c); }
  computeSummary(events, ctx)             { return this._def.computeSummary(events, ctx); }
}

module.exports = { GameEngine };
