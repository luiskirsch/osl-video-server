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
const worldState   = require('../services/worldState');

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

// ── GET /live/world ───────────────────────────────────────────────────────────
// Público — world state global (communityProgress, missão, conteúdo desbloqueado).
// Usado pelo cliente pré-login para mostrar o "mundo está vivo" na tela inicial.

router.get('/live/world', asyncHandler(async (_req, res) => {
  const world = await worldState.getWorldState().catch(() => null);
  return res.json({ ok: true, world });
}));

module.exports = router;
