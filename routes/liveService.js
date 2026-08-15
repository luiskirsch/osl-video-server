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

// ── GET /live/daily-debug (temporário) ───────────────────────────────────────

router.get('/live/daily-debug', asyncHandler(async (_req, res) => {
  const db = require('../services/firestore').db;
  const today = new Date().toISOString().slice(0, 10);
  const snap = db ? await db.collection('daily_ritual').doc(today).get().catch(e => ({ _err: e.message })) : null;
  const snapExists = snap && snap.exists !== undefined ? snap.exists : 'db_null_or_error';
  const snapData = snap && snap.data ? snap.data() : null;
  const daily = await liveService.getDailyRitual().catch(e => ({ _err: e.message }));
  return res.json({ ok: true, today, dbAvail: !!db, snapExists, cardText: snapData?.cardText?.slice(0,60) ?? null, daily });
}));

// ── GET /live/world ───────────────────────────────────────────────────────────
// Público — world state global (communityProgress, missão, conteúdo desbloqueado).
// Usado pelo cliente pré-login para mostrar o "mundo está vivo" na tela inicial.

router.get('/live/world', asyncHandler(async (_req, res) => {
  const world = await worldState.getWorldState().catch(() => null);
  return res.json({ ok: true, world });
}));

module.exports = router;
