'use strict';

/**
 * services/notifications.js — Inbox de notificações in-app
 *
 * Armazenamento: users/{uid}/notifications/{id}
 * Schema:
 *   { type, title, body, data: {}, read: bool, createdAt }
 *
 * Tipos emitidos automaticamente:
 *   achievement_unlocked   — ao desbloquear conquista
 *   friend_accepted        — ao aceitar amizade (futuro)
 *
 * API pública:
 *   createNotification(uid, { type, title, body, data })  → docId
 *   getNotifications(uid, { limit, unreadOnly })           → Notification[]
 *   markRead(uid, notifId)                                 → void
 *   markAllRead(uid)                                       → count
 *   init()                                                 → registra listeners
 */

const logger = require('../logger');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── API pública ───────────────────────────────────────────────────────────────

async function createNotification(uid, { type, title, body, data = {} }) {
  const db = getDb();
  if (!db || !uid) return null;

  const ref = await db.collection('users').doc(uid)
    .collection('notifications')
    .add({
      type:      String(type  || 'info').slice(0, 50),
      title:     String(title || '').slice(0, 200),
      body:      String(body  || '').slice(0, 1000),
      data:      data || {},
      read:      false,
      createdAt: new Date(),
    });

  return ref.id;
}

async function getNotifications(uid, { limit = 30, unreadOnly = false } = {}) {
  const db = getDb();
  if (!db || !uid) return [];

  const cap = Math.min(Number(limit) || 30, 100);
  let query = db.collection('users').doc(uid)
    .collection('notifications')
    .orderBy('createdAt', 'desc')
    .limit(cap);

  if (unreadOnly) query = query.where('read', '==', false);

  const snap = await query.get();
  return snap.docs.map(d => ({
    id:        d.id,
    type:      d.data().type,
    title:     d.data().title,
    body:      d.data().body,
    data:      d.data().data || {},
    read:      d.data().read,
    createdAt: d.data().createdAt?.toMillis?.() ?? null,
  }));
}

async function markRead(uid, notifId) {
  const db = getDb();
  if (!db || !uid || !notifId) return;
  await db.collection('users').doc(uid)
    .collection('notifications').doc(notifId)
    .update({ read: true })
    .catch(() => {});
}

async function markAllRead(uid) {
  const db = getDb();
  if (!db || !uid) return 0;

  const snap = await db.collection('users').doc(uid)
    .collection('notifications')
    .where('read', '==', false)
    .get();

  if (snap.empty) return 0;

  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
  return snap.size;
}

async function getUnreadCount(uid) {
  const db = getDb();
  if (!db || !uid) return 0;
  const snap = await db.collection('users').doc(uid)
    .collection('notifications')
    .where('read', '==', false)
    .count()
    .get()
    .catch(() => null);
  return snap?.data()?.count ?? 0;
}

// ── Listeners ─────────────────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  // Conquista desbloqueada
  events.on('user.achievement_unlocked', async ({ payload }) => {
    const { uid, achievementId, title } = payload || {};
    if (!uid) return;

    await createNotification(uid, {
      type:  'achievement_unlocked',
      title: 'Conquista desbloqueada!',
      body:  title,
      data:  { achievementId },
    }).catch(() => {});
  });

  // Sessão encerrada — avisa jogadores da sessão (summary recap disponível)
  events.on('session.ended', async ({ payload }) => {
    const { roomId, sessionId, summary, players } = payload || {};
    if (!players || !sessionId) return;

    const authedPlayers = (players || []).filter(p => p.userId);
    if (!authedPlayers.length) return;

    const cardsRevealed = summary?.cardsRevealed || 0;
    const durationMin   = Math.round((summary?.durationSec || 0) / 60);

    for (const p of authedPlayers) {
      await createNotification(p.userId, {
        type:  'session_ended',
        title: 'Sessão encerrada',
        body:  `${cardsRevealed} cartas em ${durationMin} min. Veja o recap!`,
        data:  { roomId, sessionId },
      }).catch(() => {});
    }
  });

  // Ritual diário completado pelo grupo
  events.on('live.daily_ritual_completed', async ({ payload }) => {
    const { authedUids, date, cardTitle } = payload || {};
    if (!Array.isArray(authedUids)) return;

    for (const uid of authedUids) {
      await createNotification(uid, {
        type:  'daily_ritual_completed',
        title: 'Ritual Diário completo!',
        body:  `"${cardTitle}" — ${date}`,
        data:  { date, cardTitle },
      }).catch(() => {});
    }
  });

  logger.info({}, 'notifications_initialized');
}

module.exports = { createNotification, getNotifications, markRead, markAllRead, getUnreadCount, init };
