'use strict';

/**
 * routes/recurringGroups.js — Agendamento recorrente de sessões (P2)
 *
 * POST   /game/room/:roomId/schedule    — cria/atualiza agenda (host)
 * GET    /game/room/:roomId/schedule    — lê agenda (público)
 * DELETE /game/room/:roomId/schedule    — desativa agenda (host)
 */

const express = require('express');
const { verifyHostToken }         = require('../services/auth');
const { asyncHandler, sendError } = require('../utils');
const recurringGroups             = require('../services/recurringGroups');

const router = express.Router();

// POST /game/room/:roomId/schedule
router.post('/game/room/:roomId/schedule', asyncHandler(async (req, res) => {
  const { roomId }  = req.params;
  const { hostToken, hostUid, dayOfWeek, utcHour, utcMinute, notifyMinutesBefore } = req.body || {};

  if (!verifyHostToken(hostToken, roomId)) {
    return res.status(403).json({ ok: false, error: 'HOST_TOKEN_INVALIDO' });
  }
  if (!hostUid) return sendError(res, 400, 'HOST_UID_OBRIGATORIO');

  try {
    await recurringGroups.setSchedule(roomId, hostUid, { dayOfWeek, utcHour, utcMinute, notifyMinutesBefore });
    const schedule = await recurringGroups.getSchedule(roomId);
    return res.status(201).json({ ok: true, schedule });
  } catch (e) {
    if (e.code === 400) return sendError(res, 400, e.message);
    throw e;
  }
}));

// GET /game/room/:roomId/schedule
router.get('/game/room/:roomId/schedule', asyncHandler(async (req, res) => {
  const schedule = await recurringGroups.getSchedule(req.params.roomId);
  return res.json({ ok: true, schedule });
}));

// DELETE /game/room/:roomId/schedule
router.delete('/game/room/:roomId/schedule', asyncHandler(async (req, res) => {
  const { roomId }  = req.params;
  const { hostToken, hostUid } = req.body || {};

  if (!verifyHostToken(hostToken, roomId)) {
    return res.status(403).json({ ok: false, error: 'HOST_TOKEN_INVALIDO' });
  }
  if (!hostUid) return sendError(res, 400, 'HOST_UID_OBRIGATORIO');

  try {
    await recurringGroups.deactivate(roomId, hostUid);
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === 404) return sendError(res, 404, e.message);
    if (e.code === 403) return sendError(res, 403, e.message);
    throw e;
  }
}));

module.exports = router;
