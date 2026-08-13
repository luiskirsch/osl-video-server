'use strict';

/**
 * routes/rooms.js — Configurações e descoberta de salas públicas (Priority #13)
 *
 * GET  /rooms/public                  — lista salas públicas com sessão ativa
 * PUT  /game/room/:roomId/settings    — atualiza config da sala (host only)
 * GET  /game/room/:roomId/settings    — lê config pública da sala
 */

const express = require('express');
const admin   = require('firebase-admin');
const { verifyHostToken }             = require('../services/auth');
const { getDb }                       = require('../services/firestore');
const { panelRooms }                  = require('../game/state');
const { asyncHandler, sendError }     = require('../utils');
const { logInfo }                     = require('../logger');

const router = express.Router();

const VALID_TAGS = new Set([
  'casual', 'intenso', 'adulto', 'casal', 'amigos', 'familia',
  'online', 'presencial', 'therapy', 'curto', 'longo',
]);

function sanitizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(t => String(t).toLowerCase().trim())
    .filter(t => VALID_TAGS.has(t))
    .slice(0, 5);
}

// ── GET /rooms/public ─────────────────────────────────────────────────────────

router.get('/rooms/public', asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const limit = Math.min(Number(req.query.limit || 20), 50);
  const tag   = req.query.tag ? String(req.query.tag).toLowerCase().trim() : null;

  // Salas públicas com jogo ativo no Firestore
  let query = db.collection('salas')
    .where('public', '==', true)
    .where('arenaActive', '==', true)
    .orderBy('updatedAt', 'desc')
    .limit(limit * 2);   // sobreamostra para filtrar por tag

  const snap = await query.get();

  const rooms = snap.docs
    .map(d => {
      const data = d.data();
      // Enriquece com estado em memória (playerCount em tempo real)
      const live = panelRooms.get(d.id) || {};
      return {
        roomId:      d.id,
        name:        data.name        || 'Sala Sem Nome',
        emoji:       data.emoji       || '🎴',
        description: data.description || '',
        tags:        data.tags        || [],
        playerCount: Object.keys(live.players || data.players || {}).length,
        sessionActive: !!data.arenaActive,
        updatedAt:   data.updatedAt?.toMillis?.() ?? null,
      };
    })
    .filter(r => !tag || r.tags.includes(tag))
    .slice(0, limit);

  return res.json({ ok: true, rooms, count: rooms.length });
}));

// ── PUT /game/room/:roomId/settings ──────────────────────────────────────────

router.put('/game/room/:roomId/settings', asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { hostToken, name, emoji, description, tags, public: isPublic, maxPlayers } = req.body || {};

  if (!verifyHostToken(hostToken, roomId)) {
    return res.status(403).json({ ok: false, error: 'HOST_TOKEN_INVALIDO' });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (name        !== undefined) update.name        = String(name).slice(0, 80);
  if (emoji       !== undefined) update.emoji       = String(emoji).slice(0, 8);
  if (description !== undefined) update.description = String(description).slice(0, 300);
  if (tags        !== undefined) update.tags        = sanitizeTags(tags);
  if (isPublic    !== undefined) update.public      = isPublic === true || isPublic === 'true';
  if (maxPlayers  !== undefined) update.maxPlayers  = Math.max(2, Math.min(20, Number(maxPlayers) || 8));

  await db.collection('salas').doc(roomId).update(update);

  logInfo('room_settings_updated', { roomId, public: update.public });
  return res.json({ ok: true, roomId });
}));

// ── GET /game/room/:roomId/settings ──────────────────────────────────────────

router.get('/game/room/:roomId/settings', asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const snap = await db.collection('salas').doc(req.params.roomId).get();
  if (!snap.exists) return sendError(res, 404, 'SALA_NAO_ENCONTRADA');

  const d = snap.data();
  return res.json({
    ok: true,
    settings: {
      roomId:      snap.id,
      name:        d.name        || '',
      emoji:       d.emoji       || '🎴',
      description: d.description || '',
      tags:        d.tags        || [],
      public:      !!d.public,
      maxPlayers:  d.maxPlayers  || 8,
    },
  });
}));

module.exports = router;
