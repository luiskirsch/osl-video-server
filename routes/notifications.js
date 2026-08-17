'use strict';

/**
 * routes/notifications.js — Inbox de notificações do jogador
 *
 * GET  /notifications              — lista (últimas 30, ou ?unread=true)
 * GET  /notifications/count        — contagem de não lidas
 * POST /notifications/:id/read     — marca uma como lida
 * POST /notifications/read-all     — marca todas como lidas
 */

const express      = require('express');
const admin        = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const notifications = require('../services/notifications');

const router = express.Router();

async function getUid(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
             || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (_) { return null; }
}

// GET /notifications
router.get('/notifications', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const limit      = Math.min(Number(req.query.limit || 30), 100);
  const unreadOnly = req.query.unread === 'true';

  const notifs = await notifications.getNotifications(uid, { limit, unreadOnly });
  return res.json({ ok: true, notifications: notifs, count: notifs.length });
}));

// GET /notifications/count
router.get('/notifications/count', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const count = await notifications.getUnreadCount(uid);
  return res.json({ ok: true, unread: count });
}));

// POST /notifications/:id/read
router.post('/notifications/:id/read', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  await notifications.markRead(uid, req.params.id);
  return res.json({ ok: true });
}));

// POST /notifications/read-all
router.post('/notifications/read-all', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const count = await notifications.markAllRead(uid);
  return res.json({ ok: true, marked: count });
}));

// DELETE /notifications/:id
router.delete('/notifications/:id', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  await notifications.deleteNotification(uid, req.params.id);
  return res.json({ ok: true });
}));

module.exports = router;
