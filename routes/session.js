'use strict';

/**
 * routes/session.js — Endpoints de sessão e DNA de grupo
 *
 * Todos exigem Firebase ID token (Bearer header).
 *
 * GET /game/room/:roomId/dna
 *   Perfil agregado do grupo: padrões de conteúdo, reação e horário.
 *
 * GET /game/room/:roomId/sessions/:sessionId/recap
 *   Resumo formatado de uma sessão encerrada (summary + highlights).
 *
 * GET /game/room/:roomId/sessions/:sessionId/replay
 *   Timeline completa de eventos da sessão, ordenada por timestamp.
 */

const express = require('express');
const admin   = require('firebase-admin');
const { getDb }              = require('../services/firestore');
const sessionDna             = require('../services/sessionDna');
const socialGraph            = require('../services/socialGraph');
const { GameEngine }         = require('../game/engine');
const { asyncHandler, sendError } = require('../utils');

const router = express.Router();
const engine = new GameEngine('ritual');

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireFirebaseAuth(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) { sendError(res, 401, 'TOKEN_OBRIGATORIO'); return null; }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (_) {
    sendError(res, 403, 'TOKEN_INVALIDO');
    return null;
  }
}

// ── GET /game/room/:roomId/dna ────────────────────────────────────────────────

router.get('/game/room/:roomId/dna', asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const uid = await requireFirebaseAuth(req, res);
  if (!uid) return;

  const dna = await sessionDna.getRoomDna(roomId);
  if (!dna) return res.json({ ok: true, dna: null });

  // Serializa datas para milissegundos (Firestore Date → number)
  const out = { ...dna };
  if (out.updatedAt?.getTime)   out.updatedAt   = out.updatedAt.getTime();
  if (out.lastPlayedAt?.getTime) out.lastPlayedAt = out.lastPlayedAt.getTime();

  return res.json({ ok: true, dna: out });
}));

// ── GET /game/room/:roomId/sessions/:sessionId/recap ─────────────────────────

router.get('/game/room/:roomId/sessions/:sessionId/recap', asyncHandler(async (req, res) => {
  const { roomId, sessionId } = req.params;
  const uid = await requireFirebaseAuth(req, res);
  if (!uid) return;

  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const sessRef = db.collection('salas').doc(roomId).collection('sessions').doc(sessionId);

  const [sessSnap, eventsSnap] = await Promise.all([
    sessRef.get(),
    sessRef.collection('events').orderBy('ts', 'asc').get(),
  ]);

  if (!sessSnap.exists) return sendError(res, 404, 'SESSION_NAO_ENCONTRADA');

  const sessData = sessSnap.data();
  const summary  = sessData.summary || null;

  if (!summary) return sendError(res, 409, 'SESSION_AINDA_ATIVA');

  const rawEvents = eventsSnap.docs.map(d => d.data());
  const highlights = engine.computeHighlights(rawEvents, summary);

  const recap = {
    sessionId,
    roomId,
    createdAt:   sessData.createdAt?.toMillis?.()  || null,
    endedAt:     sessData.endedAt?.toMillis?.()    || null,
    playerCount: (sessData.players || []).length,
    summary,
    highlights,
  };

  return res.json({ ok: true, recap });
}));

// ── GET /game/room/:roomId/sessions/:sessionId/replay ────────────────────────

router.get('/game/room/:roomId/sessions/:sessionId/replay', asyncHandler(async (req, res) => {
  const { roomId, sessionId } = req.params;
  const uid = await requireFirebaseAuth(req, res);
  if (!uid) return;

  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const sessRef  = db.collection('salas').doc(roomId).collection('sessions').doc(sessionId);
  const sessSnap = await sessRef.get();

  if (!sessSnap.exists) return sendError(res, 404, 'SESSION_NAO_ENCONTRADA');

  const eventsSnap = await sessRef
    .collection('events')
    .orderBy('ts', 'asc')
    .get();

  const timeline = eventsSnap.docs.map(d => {
    const e = d.data();
    return {
      eventId: d.id,
      type:    e.type,
      ts:      e.ts?.toMillis?.() || null,
      actor:   e.actor || null,
      payload: e.payload || {},
    };
  });

  const sessData = sessSnap.data();
  return res.json({
    ok: true,
    sessionId,
    roomId,
    status:    sessData.status    || null,
    createdAt: sessData.createdAt?.toMillis?.() || null,
    endedAt:   sessData.endedAt?.toMillis?.()   || null,
    timeline,
  });
}));

// ── GET /game/room/:roomId/group ──────────────────────────────────────────────
// Perfil do grupo recorrente: roster de jogadores, core members, DNA resumido.

router.get('/game/room/:roomId/group', asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const uid = await requireFirebaseAuth(req, res);
  if (!uid) return;

  const dna = await sessionDna.getRoomDna(roomId);
  if (!dna) return res.json({ ok: true, group: null });

  // Serializa datas
  const lastPlayedAt = dna.lastPlayedAt?.getTime?.() || null;

  // Monta perfil do grupo a partir do DNA
  const group = {
    roomId,
    sessionCount:       dna.sessionCount      || 0,
    uniquePlayerCount:  dna.uniquePlayerCount  || 0,
    coreMembers:        dna.coreMembers        || [],
    playerRoster:       dna.playerRoster       || {},
    lastPlayedAt,
    favCardType: Object.entries(dna.cardTypeCounts || {})
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    favEmoji: Object.entries(dna.emojiTally || {})
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    topCards:           (dna.topCards || []).slice(0, 5),
    avgDurationSec:     dna.avgDurationSec     || 0,
    avgCardsPerSession: dna.avgCardsPerSession  || 0,
    topReactors:        (dna.topReactors || []).slice(0, 3),
    playDayOfWeek:      dna.playDayOfWeek      || {},
    playHourOfDay:      dna.playHourOfDay      || {},
  };

  return res.json({ ok: true, group });
}));

module.exports = router;
