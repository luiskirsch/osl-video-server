'use strict';

/**
 * EventBus — pub/sub interno single-process.
 *
 * Design: Node EventEmitter puro com suporte a wildcards (ritual.* / *).
 * Para escalar multi-instância no futuro, trocar o emitter por um adapter
 * Redis Pub/Sub sem mudar nenhum consumer — a API permanece idêntica.
 *
 * Emitir com { persist: true } grava o evento na coleção platform_events
 * no Firestore, alimentando Session DNA (P1) e Telemetry (P1).
 */

const { EventEmitter } = require('events');
const logger = require('../logger');

const emitter = new EventEmitter();
emitter.setMaxListeners(128);

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Emite um evento para todos os handlers registrados (exato + wildcards).
 *
 * @param {string} topic  Ex: 'ritual.card_revealed', 'room.player_joined'
 * @param {object} payload
 * @param {{ persist?: boolean }} [opts]
 */
function emit(topic, payload = {}, opts = {}) {
  if (!topic || typeof topic !== 'string') return;

  const event = { topic, payload, ts: Date.now() };

  // Disparo exato
  emitter.emit(topic, event);

  // Wildcards hierárquicos: 'ritual.card_revealed' → 'ritual.*' → '*'
  const parts = topic.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    emitter.emit(parts.slice(0, i).join('.') + '.*', event);
  }
  emitter.emit('*', event);

  if (opts.persist) {
    _persist(event).catch(err =>
      logger.warn({ err, topic }, 'event_persist_failed')
    );
  }
}

/**
 * Assina um tópico ou padrão wildcard.
 * Handler erros são capturados e logados — nunca propagam para o emitter.
 *
 * @param {string}   topic   Ex: 'ritual.*', '*', 'room.player_joined'
 * @param {Function} handler async ({ topic, payload, ts }) => void
 * @returns {Function} unsub — chama para cancelar a assinatura
 */
function on(topic, handler) {
  const wrapped = (event) => {
    Promise.resolve(handler(event)).catch(err =>
      logger.error({ err, topic }, 'event_handler_error')
    );
  };
  emitter.on(topic, wrapped);
  return () => emitter.off(topic, wrapped);
}

/**
 * Assina um tópico, dispara apenas uma vez.
 */
function once(topic, handler) {
  emitter.once(topic, (event) => {
    Promise.resolve(handler(event)).catch(err =>
      logger.error({ err, topic }, 'event_handler_once_error')
    );
  });
}

// ── Persistência opcional ─────────────────────────────────────────────────────

// Lazy-require evita circular dep no boot (firestore.js → events.js → firestore.js)
let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

async function _persist(event) {
  const db = getDb();
  if (!db) return;
  await db.collection('platform_events').add({
    topic:     event.topic,
    payload:   event.payload,
    ts:        event.ts,
    createdAt: new Date(),
  });
}

// ── Catálogo de tópicos (documentação viva) ───────────────────────────────────
// Prefixo    → domínio
// ritual.*   → estado do ritual (cartas, efeitos, votos, reações)
// room.*     → ciclo de vida da sala (criação, join, leave, close)
// session.*  → sessão de jogo (início, fim, jogadores)
// payment.*  → pagamentos (aprovado, estornado)
// user.*     → perfil do jogador (xp, moedas, conquistas)
// flag.*     → feature flags (criação, atualização)
// content.*  → cartas e packs (criação, atualização, remoção)
// engine.*   → game engine (adaptive_applied, etc.)
// live.*     → live service (daily_ritual_completed, season_started, etc.)

module.exports = { emit, on, once };
