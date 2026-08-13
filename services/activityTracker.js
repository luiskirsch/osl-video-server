'use strict';

/**
 * services/activityTracker.js — Atividade em tempo real dos amigos
 *
 * Escuta ritual.started e session.ended para manter users/{uid}.lastActivity
 * atualizado no Firestore e emitir social:friend_activity via socket.io para
 * as conexões do jogador.
 *
 * O campo lastActivity tem TTL implícito: o hub ignora atividades com mais
 * de ACTIVITY_STALE_MS (90 min) como se fossem null.
 *
 * Não emite "offline" no session.ended — o estado decai naturalmente.
 * O cliente mostra "estava no Ritual (há X min)" para atividades dentro do TTL.
 */

const logger = require('../logger');
const admin  = require('firebase-admin');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

function _activityTypeFromPayload(payload) {
  if (payload.mode === 'duo')   return 'duo';
  if (payload.mode === 'quick') return 'quick_ritual';
  // Fallback: inferir pelo prefixo do roomId (quick-ritual usa roomId com prefixo)
  if (String(payload.roomId || '').startsWith('duo-'))   return 'duo';
  if (String(payload.roomId || '').startsWith('quick-')) return 'quick_ritual';
  return 'ritual';
}

async function _setActivity(uid, activity) {
  const db = getDb();
  if (!db || !uid) return;
  await db.collection('users').doc(uid).update({
    lastActivity:   activity,
    lastActivityAt: activity ? new Date() : null,
  }).catch(() => {});
}

async function _notifyConnections(uid, activity) {
  try {
    const socialGraph    = require('./socialGraph');
    const { emitToUser } = require('./socketio');
    const connections    = await socialGraph.getConnections(uid, 10);
    for (const conn of connections) {
      emitToUser(conn.uid, 'social:friend_activity', { uid, activity });
    }
  } catch (err) {
    logger.warn({ err, uid: uid.slice(0, 8) }, 'activity_notify_failed');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  // Ritual iniciado → registra atividade para o host e notifica amigos
  events.on('ritual.started', async ({ payload }) => {
    const { roomId, hostUid } = payload || {};
    if (!hostUid) return;

    const type     = _activityTypeFromPayload(payload);
    const activity = { type, roomId, startedAt: admin.firestore.FieldValue.serverTimestamp() };

    await _setActivity(hostUid, activity).catch(() => {});
    await _notifyConnections(hostUid, { type, roomId, startedAt: Date.now() }).catch(() => {});
  });

  // Sessão encerrada → limpa atividade de todos os jogadores autenticados
  // Não emite socket — o estado decai via TTL, sem noise de reconexão.
  events.on('session.ended', async ({ payload }) => {
    const { players } = payload || {};
    if (!Array.isArray(players)) return;

    const authedUids = [...new Set(players.map(p => p.userId).filter(Boolean))];
    await Promise.all(authedUids.map(uid => _setActivity(uid, null))).catch(() => {});
  });

  logger.info('activity_tracker_initialized');
}

module.exports = { init };
