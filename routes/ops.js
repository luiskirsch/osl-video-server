'use strict';

/**
 * routes/ops.js — Game Operations Center
 *
 * Dashboard operacional para o admin. Todas as rotas exigem x-admin-secret.
 *
 * GET /ops/dashboard     → visão geral: realtime + stats 24h/7d + top eventos
 * GET /ops/telemetry     → contagens de eventos por tópico (?hours=24|168)
 * GET /ops/rooms         → salas ativas em memória com estado atual
 */

const express    = require('express');
const { requireAdmin }    = require('../services/auth');
const { asyncHandler }    = require('../utils');
const telemetry           = require('../services/telemetry');
const adaptiveEngine      = require('../services/adaptiveEngine');
const sessionDna          = require('../services/sessionDna');
const { panelRooms, panelClients, activeRecordings, activeStreams } = require('../game/state');

const router = express.Router();

// ── GET /ops/dashboard ────────────────────────────────────────────────────────

router.get('/ops/dashboard', requireAdmin, asyncHandler(async (_req, res) => {
  const stats = await telemetry.getStats();

  const activeRoomList = Array.from(panelRooms.values())
    .filter(r => r.sessionActive || r.videoActive);

  return res.json({
    ok: true,
    timestamp: Date.now(),
    realtime: {
      activeRooms:         activeRoomList.length,
      totalTrackedRooms:   panelRooms.size,
      panelConnections:    panelClients.size,
      activeRecordings:    activeRecordings.size,
      activeStreams:        activeStreams.size,
    },
    stats24h:    stats.stats24h,
    stats7d:     stats.stats7d,
    topTopics24h: stats.topTopics24h,
    cacheComputedAt: stats.computedAt,
  });
}));

// ── GET /ops/telemetry ────────────────────────────────────────────────────────

router.get('/ops/telemetry', requireAdmin, asyncHandler(async (req, res) => {
  const stats = await telemetry.getStats();
  const hours = Number(req.query.hours || 24);

  const topTopics = hours <= 24 ? stats.topTopics24h : stats.topTopics7d;
  const sessionStats = hours <= 24 ? stats.stats24h : stats.stats7d;

  return res.json({
    ok: true,
    hours,
    sessionStats,
    topTopics,
    computedAt: stats.computedAt,
  });
}));

// POST /ops/telemetry/cache/invalidate — força recompute
router.post('/ops/telemetry/cache/invalidate', requireAdmin, (_req, res) => {
  telemetry.invalidateCache();
  return res.json({ ok: true });
});

// ── GET /ops/rooms ────────────────────────────────────────────────────────────

router.get('/ops/rooms', requireAdmin, (_req, res) => {
  const rooms = Array.from(panelRooms.values()).map(r => ({
    roomId:          r.roomId,
    name:            r.name   || '',
    host:            r.host   || '',
    sessionActive:   !!r.sessionActive,
    videoActive:     !!r.videoActive,
    recordingActive: !!r.recordingActive,
    streamingActive: !!r.streamingActive,
    playerCount:     Object.keys(r.players || {}).length,
    updatedAt:       r.updatedAt || null,
  }));

  return res.json({ ok: true, rooms, total: rooms.length });
});

// ── GET /ops/adaptive ─────────────────────────────────────────────────────────
// Status do Adaptive Ritual Engine: flag ativa + DNA de salas rastreadas.

router.get('/ops/adaptive', requireAdmin, asyncHandler(async (_req, res) => {
  const engineEnabled = await adaptiveEngine.isEnabled(null);

  // Salas rastreadas em memória com DNA disponível
  const roomIds  = Array.from(panelRooms.keys());
  const dnaList  = await Promise.all(
    roomIds.map(async (roomId) => {
      const dna = await sessionDna.getRoomDna(roomId).catch(() => null);
      return dna ? {
        roomId,
        sessionCount:      dna.sessionCount      || 0,
        eligibleForEngine: (dna.sessionCount || 0) >= 3,
        avgCardsPerSession: dna.avgCardsPerSession || 0,
        topCardType: Object.entries(dna.cardTypeCounts || {})
          .sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      } : null;
    })
  );

  return res.json({
    ok: true,
    flag:    'adaptive_ritual_engine',
    enabled: engineEnabled,
    minSessionsRequired: 3,
    rooms: dnaList.filter(Boolean).sort((a, b) => b.sessionCount - a.sessionCount),
  });
}));

module.exports = router;
