'use strict';

/**
 * Rotas da camada de plataforma — consumidas diretamente pelo frontend/desktop.
 *
 * GET /platform/flags  — feature flags ativas para o usuário atual
 *                        (Firebase ID token opcional; sem token retorna flags globais)
 */

const express      = require('express');
const admin        = require('firebase-admin');
const featureFlags  = require('../services/featureFlags');
const experiments   = require('../services/experiments');
const { asyncHandler } = require('../utils');

const router = express.Router();

// GET /platform/flags
// Retorna { flagName: boolean } — mapa completo de flags para o uid do solicitante.
// Frontend usa isso no boot para ativar/desativar features sem nova requisição.
router.get('/platform/flags', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  let uid = null;
  if (token) {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
    } catch (_) { /* token inválido — trata como anônimo */ }
  }

  const flags = await featureFlags.getEnabledFlags(uid);
  return res.json({ ok: true, uid, flags });
}));

// GET /platform/experiments/assignments
// Retorna { expName: variant } para o usuário atual.
// Firebase ID token opcional: sem token retorna atribuições anônimas (uid=null).
router.get('/platform/experiments/assignments', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  let uid = null;
  if (token) {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
    } catch (_) { /* token inválido — trata como anônimo */ }
  }

  const assignments = await experiments.getAllVariants(uid);
  return res.json({ ok: true, uid, assignments });
}));

module.exports = router;
