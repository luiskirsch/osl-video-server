'use strict';

/**
 * routes/content.js — CRUD de cartas e packs pelo painel admin.
 *
 * Todas as rotas exigem x-admin-secret ou panel session token.
 *
 * GET  /content/cards                  — lista cartas (filtra por packId=)
 * POST /content/cards                  — cria carta
 * PUT  /content/cards/:id             — atualiza carta
 * DELETE /content/cards/:id           — remove carta
 *
 * GET  /content/packs                  — lista packs disponíveis
 *
 * POST /content/seed                   — importa dados estáticos para Firestore
 *                                        body: { overwrite?: boolean }
 * POST /content/cache/invalidate       — limpa cache do content engine
 */

const express      = require('express');
const admin        = require('firebase-admin');
const { requireAdmin } = require('../services/auth');
const { getDb }    = require('../services/firestore');
const contentEngine = require('../services/contentEngine');
const events        = require('../services/events');
const { asyncHandler, sendError } = require('../utils');
const logger = require('../logger');

const router = express.Router();

// ── Cartas ─────────────────────────────────────────────────────────────────────

// GET /content/cards?packId=null|<packId>&enabled=true|false
router.get('/content/cards', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  let query = db.collection('content_cards');
  const { packId, enabled } = req.query;

  if (packId === 'null' || packId === '') {
    query = query.where('packId', '==', null);
  } else if (packId) {
    query = query.where('packId', '==', packId);
  }
  if (enabled !== undefined) {
    query = query.where('enabled', '==', enabled !== 'false');
  }

  const snap = await query.orderBy('order', 'asc').get();
  const cards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return res.json({ ok: true, cards, total: cards.length });
}));

// POST /content/cards — cria nova carta
router.post('/content/cards', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { type, title, text, rule, subrule, phrase, packId, effects, tags, intensity, minPlayers, enabled, order } = req.body || {};
  if (!title || !text) return sendError(res, 400, 'TITULO_E_TEXTO_OBRIGATORIOS');

  const now = admin.firestore.FieldValue.serverTimestamp();
  const data = {
    packId:     packId   || null,
    type:       String(type || 'Ritual').slice(0, 50),
    title:      String(title).slice(0, 200),
    text:       String(text).slice(0, 2000),
    rule:       rule    ? String(rule).slice(0, 500)    : null,
    subrule:    subrule ? String(subrule).slice(0, 500) : null,
    phrase:     phrase  ? String(phrase).slice(0, 300)  : null,
    effects:    effects || null,
    tags:       Array.isArray(tags) ? tags.slice(0, 20).map(t => String(t).slice(0, 50)) : [],
    intensity:  ['low', 'medium', 'high'].includes(intensity) ? intensity : 'medium',
    minPlayers: typeof minPlayers === 'number' ? Math.max(2, Math.min(10, minPlayers)) : 2,
    enabled:    enabled !== false,
    order:      typeof order === 'number' ? order : 9999,
    createdAt:  now,
    updatedAt:  now,
  };

  const ref = await db.collection('content_cards').add(data);

  contentEngine.invalidate();
  events.emit('content.card_created', { cardId: ref.id, title: data.title, packId: data.packId });
  logger.info({ cardId: ref.id, title: data.title }, 'content_card_created');
  return res.status(201).json({ ok: true, id: ref.id });
}));

// PUT /content/cards/:id — atualiza carta
router.put('/content/cards/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { id } = req.params;
  const ref  = db.collection('content_cards').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, 'CARTA_NAO_ENCONTRADA');

  const allowed = ['type', 'title', 'text', 'rule', 'subrule', 'phrase', 'packId',
                   'effects', 'tags', 'intensity', 'minPlayers', 'enabled', 'order'];
  const update  = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key];
  }

  await ref.update(update);
  contentEngine.invalidate();
  events.emit('content.card_updated', { cardId: id });
  return res.json({ ok: true, id });
}));

// DELETE /content/cards/:id — remove carta (soft: enabled=false, ou hard com ?hard=true)
router.delete('/content/cards/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { id } = req.params;
  const hard = req.query.hard === 'true';

  if (hard) {
    await db.collection('content_cards').doc(id).delete();
    logger.info({ cardId: id }, 'content_card_deleted_hard');
  } else {
    await db.collection('content_cards').doc(id).update({
      enabled: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info({ cardId: id }, 'content_card_disabled');
  }

  contentEngine.invalidate();
  events.emit('content.card_deleted', { cardId: id, hard });
  return res.json({ ok: true, id, hard });
}));

// ── Packs ─────────────────────────────────────────────────────────────────────

// GET /content/packs — retorna contagem de cartas por pack a partir do content engine
router.get('/content/packs', requireAdmin, asyncHandler(async (_req, res) => {
  const bundle = await contentEngine.getContentBundle();
  const packs = bundle.packIds.map(id => ({
    packId: id,
    cardCount: (bundle.packCardsMap[id] || []).length,
  }));
  return res.json({ ok: true, packs });
}));

// ── Utilitários ───────────────────────────────────────────────────────────────

// POST /content/seed — importa dados estáticos para Firestore (idempotente)
// body: { overwrite?: boolean }
router.post('/content/seed', requireAdmin, asyncHandler(async (req, res) => {
  const overwrite = req.body?.overwrite === true;
  const count = await contentEngine.seedFromStatic(overwrite);
  logger.info({ count, overwrite }, 'content_seed_executed');
  return res.json({ ok: true, imported: count, overwrite });
}));

// POST /content/cache/invalidate — força limpeza de cache do content engine
router.post('/content/cache/invalidate', requireAdmin, (_req, res) => {
  contentEngine.invalidate();
  return res.json({ ok: true });
});

module.exports = router;
