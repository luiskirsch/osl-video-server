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

const liveService             = require('../services/liveService');

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

// ── GET /ops/live ─────────────────────────────────────────────────────────────
// Estado atual do Live Service: temporada, eventos ativos, ritual do dia.

router.get('/ops/live', requireAdmin, asyncHandler(async (_req, res) => {
  const [season, activeEvents, daily] = await Promise.all([
    liveService.getActiveSeason(),
    liveService.getActiveEvents(),
    liveService.getDailyRitual(),
  ]);

  return res.json({
    ok: true,
    season:       season || null,
    activeEvents,
    daily:        daily  || null,
    eventCount:   activeEvents.length,
  });
}));

// ── GET /ops/selection-audit — Por que esta carta? ────────────────────────────
//
// Últimas N decisões do Contextual Selection (shadow + applied).
// Mostra score, reasons[] com contribuições numéricas e se teria divergido do deck legado.
// Habilita rollout científico: ative contextual_selection_v1 quando os dados derem confiança.
//
// ?limit=20  — máximo de 100 registros
// ?type=shadow|applied — filtro opcional

router.get('/ops/selection-audit', requireAdmin, asyncHandler(async (req, res) => {
  const db = require('../services/firestore').db;
  if (!db) return res.status(503).json({ ok: false, error: 'DB_INDISPONIVEL' });

  const limit     = Math.min(Number(req.query.limit || 20), 100);
  const typeFilter = req.query.type || null;

  let query = db.collection('selection_audit').orderBy('ts', 'desc').limit(limit);
  if (typeFilter === 'shadow' || typeFilter === 'applied') {
    query = query.where('type', '==', typeFilter);
  }

  const snap = await query.get().catch(() => null);
  if (!snap) return res.status(503).json({ ok: false, error: 'QUERY_FAILED' });

  const records = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id:              doc.id,
      type:            d.type,
      roomId:          d.roomId,
      groupSize:       d.groupSize,
      mode:            d.mode,
      temporal:        d.temporal,
      confidence:      d.confidence      ?? null,
      wouldDiffer:     d.wouldDiffer     ?? null,
      rankCorrelation: d.rankCorrelation ?? null,
      legacyTop5:      d.legacyTop5      || null,
      shadowTop5:      d.shadowTop5      || null,
      starterCard:     d.starterCard     || null,
      selections:      d.selections      || [],
      ts:              d.ts,
    };
  });

  const total          = records.length;
  const shadowCount    = records.filter(r => r.type === 'shadow').length;
  const appliedCount   = records.filter(r => r.type === 'applied').length;
  const wouldDiffCount = records.filter(r => r.wouldDiffer === true).length;
  const differRate     = shadowCount > 0 ? +(wouldDiffCount / shadowCount).toFixed(3) : null;

  // Confidence média (sinais inferidos — quanto dado existe por decisão)
  const confRecords   = records.filter(r => r.confidence != null);
  const avgConfidence = confRecords.length > 0
    ? +(confRecords.reduce((s, r) => s + r.confidence, 0) / confRecords.length).toFixed(3)
    : null;

  // Rank correlation média (shadow) — 1 = idêntico, 0 = sem correlação, -1 = inversão
  const corrRecords        = records.filter(r => r.rankCorrelation != null);
  const avgRankCorrelation = corrRecords.length > 0
    ? +(corrRecords.reduce((s, r) => s + r.rankCorrelation, 0) / corrRecords.length).toFixed(3)
    : null;

  // Top fatores: agrega contribution de todas as reasons[] dos registros
  const factorTotals = {};
  records.forEach(r =>
    (r.selections || []).forEach(s =>
      (s.reasons || []).forEach(({ factor, contribution }) => {
        factorTotals[factor] = (factorTotals[factor] || 0) + contribution;
      })
    )
  );
  const topFactors = Object.entries(factorTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([factor, total]) => ({ factor, total: +total.toFixed(3) }));

  return res.json({
    ok: true,
    summary: {
      total, shadowCount, appliedCount,
      wouldDifferCount:    wouldDiffCount,
      differRate,
      avgConfidence,
      avgRankCorrelation,
      topFactors,
      note: 'differRate próximo de 0 = sistema quase sempre concordaria com adaptive engine',
    },
    records,
  });
}));

module.exports = router;
