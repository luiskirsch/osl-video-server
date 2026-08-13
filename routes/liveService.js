'use strict';

/**
 * routes/liveService.js — Live Service (P2) — rotas públicas
 *
 * GET /live/season   → temporada ativa (ou null)
 * GET /live/events   → eventos ativos
 * GET /live/daily    → ritual diário de hoje
 *
 * Todas as rotas são públicas (sem auth): o conteúdo é o mesmo para todo
 * o mundo e é cacheado no serviço. Não expõe dados de usuário.
 */

const express      = require('express');
const { asyncHandler } = require('../utils');
const liveService  = require('../services/liveService');

const router = express.Router();

// ── GET /live/season ──────────────────────────────────────────────────────────

router.get('/live/season', asyncHandler(async (_req, res) => {
  const season = await liveService.getActiveSeason();
  return res.json({ ok: true, season });
}));

// ── GET /live/events ──────────────────────────────────────────────────────────

router.get('/live/events', asyncHandler(async (_req, res) => {
  const events = await liveService.getActiveEvents();
  return res.json({ ok: true, events, count: events.length });
}));

// ── GET /live/daily ───────────────────────────────────────────────────────────

router.get('/live/daily', asyncHandler(async (_req, res) => {
  const daily = await liveService.getDailyRitual();
  return res.json({ ok: true, daily });
}));

module.exports = router;
