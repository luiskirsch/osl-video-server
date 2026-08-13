'use strict';

/**
 * routes/discoveries.js — Rumores e Descobertas
 *
 * GET  /discoveries          — lista disponíveis + teasers para o usuário
 * POST /discoveries/:id/claim — revela e reivindica recompensa
 */

const express = require('express');
const admin   = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const discoveries = require('../services/discoveries');
const worldState  = require('../services/worldState');
const reputation  = require('../services/reputation');

const router = express.Router();

async function getUid(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
             || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (_) { return null; }
}

// GET /discoveries
router.get('/discoveries', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  // Contexto necessário para avaliar triggers
  const [world, rep] = await Promise.all([
    worldState.getWorldState().catch(() => null),
    reputation.getReputation(uid).catch(() => null),
  ]);

  const result = await discoveries.getDiscoveries(uid, {
    worldProgress:    world?.communityProgress || 0,
    userSessionCount: rep?.totalSessions       || 0,
  });

  return res.json({ ok: true, ...result });
}));

// POST /discoveries/:id/claim
router.post('/discoveries/:id/claim', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  try {
    const result = await discoveries.claimDiscovery(uid, req.params.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 404) return sendError(res, 404, e.message);
    if (e.code === 409) return sendError(res, 409, e.message);
    throw e;
  }
}));

module.exports = router;
