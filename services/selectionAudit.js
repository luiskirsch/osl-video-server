'use strict';

/**
 * services/selectionAudit.js — Persistência de decisões do Contextual Selection
 *
 * Escuta engine.contextual_selection_shadow e _applied.
 * Grava em selection_audit/{autoId} com TTL de 7 dias.
 *
 * Permite o GameOps responder:
 *   - O sistema teria escolhido diferente em X% das sessões?
 *   - Por que esta carta foi selecionada? (reasons com contribuições numéricas)
 *   - Quando ativar contextual_selection_v1?
 */

const logger = require('../logger');

const AUDIT_TTL_DAYS = 7;

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

function _write(type, payload) {
  const db = getDb();
  if (!db) return;
  // Usa auditId como doc ID para permitir update posterior com outcomes reais
  const ref = payload.auditId
    ? db.collection('selection_audit').doc(payload.auditId)
    : db.collection('selection_audit').doc();
  ref.set({
    type,
    roomId:          payload.roomId          || null,
    hostUid:         payload.hostUid         || null,
    groupSize:       payload.groupSize        || 1,
    mode:            payload.mode             || 'ritual',
    temporal:        payload.temporal         || null,
    confidence:      payload.confidence       ?? null,
    selections:      payload.selections       || [],
    starterCard:     payload.starterCard      || null,
    wouldDiffer:     payload.wouldDiffer      ?? null,     // shadow only
    rankCorrelation: payload.rankCorrelation  ?? null,     // shadow only
    legacyTop5:      payload.legacyTop5       || null,     // shadow only
    shadowTop5:      payload.shadowTop5       || null,     // shadow only
    ts:              Date.now(),
    expiresAt:       new Date(Date.now() + AUDIT_TTL_DAYS * 86400000),
  }).catch(() => {});
}

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  events.on('engine.contextual_selection_shadow',  ({ payload }) => _write('shadow',  payload || {}));
  events.on('engine.contextual_selection_applied', ({ payload }) => _write('applied', payload || {}));

  logger.info('selection_audit_initialized');
}

module.exports = { init };
