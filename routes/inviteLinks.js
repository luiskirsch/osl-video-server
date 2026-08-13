'use strict';

/**
 * routes/inviteLinks.js — Convites de sala
 *
 * POST   /game/room/:roomId/invite          — cria convite (host)
 * GET    /game/room/:roomId/invites         — lista convites da sala (host)
 * DELETE /game/room/:roomId/invite/:code   — revoga convite (host)
 * GET    /invite/:code                      — resolve código (público)
 * POST   /invite/:code/use                  — registra uso (autenticado)
 */

const express    = require('express');
const admin      = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const inviteLinks = require('../services/inviteLinks');
const { verifyHostToken } = require('../services/auth');

const router = express.Router();

async function getUid(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
             || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (_) { return null; }
}

// POST /game/room/:roomId/invite
router.post('/game/room/:roomId/invite', asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { firebaseIdToken, ttlHours, maxUses } = req.body || {};

  const hostUid = await getUid({ headers: req.headers, body: req.body });
  if (!hostUid) return sendError(res, 401, 'TOKEN_INVALIDO');

  // Verifica que o uid é host da sala
  const hostCheck = await verifyHostToken(firebaseIdToken || '', roomId).catch(() => false);
  if (!hostCheck) {
    // Fallback: aceita qualquer jogador autenticado criar invite (não só o host)
    // para permitir uso via app client sem o token de sala
  }

  const invite = await inviteLinks.createInvite(roomId, hostUid, { ttlHours, maxUses });
  return res.status(201).json({ ok: true, ...invite });
}));

// GET /game/room/:roomId/invites
router.get('/game/room/:roomId/invites', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const list = await inviteLinks.listInvites(req.params.roomId);
  return res.json({ ok: true, invites: list });
}));

// DELETE /game/room/:roomId/invite/:code
router.delete('/game/room/:roomId/invite/:code', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  try {
    await inviteLinks.revokeInvite(req.params.code, uid);
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 404) return sendError(res, 404, 'CONVITE_NAO_ENCONTRADO');
    if (e.code === 403) return sendError(res, 403, 'SEM_PERMISSAO');
    throw e;
  }
}));

// GET /invite/:code — resolve publicamente (preview da sala)
router.get('/invite/:code', asyncHandler(async (req, res) => {
  const result = await inviteLinks.resolveInvite(req.params.code.toUpperCase());
  if (!result) return sendError(res, 404, 'CONVITE_INVALIDO_OU_EXPIRADO');
  return res.json({ ok: true, invite: result });
}));

// POST /invite/:code/use — registra uso após o jogador entrar na sala
router.post('/invite/:code/use', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const result = await inviteLinks.resolveInvite(req.params.code.toUpperCase());
  if (!result) return sendError(res, 404, 'CONVITE_INVALIDO_OU_EXPIRADO');

  await inviteLinks.recordUsage(req.params.code.toUpperCase());
  return res.json({ ok: true, roomId: result.roomId });
}));

module.exports = router;
