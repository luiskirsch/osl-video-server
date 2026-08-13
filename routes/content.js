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
 * GET  /content/packs                  — lista packs disponíveis (metadata + cardCount)
 * POST /content/packs                  — cria pack
 * PUT  /content/packs/:id             — atualiza pack
 * DELETE /content/packs/:id           — remove pack (soft: enabled=false)
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

// GET /content/packs — lista packs com metadata e contagem de cartas
router.get('/content/packs', requireAdmin, asyncHandler(async (_req, res) => {
  const bundle = await contentEngine.getContentBundle();
  const packs = bundle.packIds.map(id => ({
    packId:    id,
    cardCount: (bundle.packCardsMap[id] || []).length,
    ...(bundle.packsMeta?.[id] || {}),
  }));
  return res.json({ ok: true, packs, total: packs.length });
}));

// POST /content/packs — cria pack
router.post('/content/packs', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { id, name, description, price, currency, coverUrl, tags, enabled, order } = req.body || {};
  if (!id || !name) return sendError(res, 400, 'ID_E_NOME_OBRIGATORIOS');

  const packId = String(id).replace(/[^a-z0-9_-]/gi, '-').slice(0, 100);
  const ref    = db.collection('content_packs').doc(packId);
  if ((await ref.get()).exists) return sendError(res, 409, 'PACK_JA_EXISTE');

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    name:        String(name).slice(0, 100),
    description: description ? String(description).slice(0, 1000) : null,
    price:       typeof price === 'number' ? price : null,
    currency:    currency ? String(currency).slice(0, 10) : 'BRL',
    coverUrl:    coverUrl ? String(coverUrl).slice(0, 500) : null,
    tags:        Array.isArray(tags) ? tags.slice(0, 20).map(t => String(t).slice(0, 50)) : [],
    enabled:     enabled !== false,
    order:       typeof order === 'number' ? order : 9999,
    createdAt:   now,
    updatedAt:   now,
  });

  contentEngine.invalidate();
  events.emit('content.pack_created', { packId, name });
  logger.info({ packId, name }, 'content_pack_created');
  return res.status(201).json({ ok: true, id: packId });
}));

// PUT /content/packs/:id — atualiza metadata do pack
router.put('/content/packs/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { id } = req.params;
  const ref    = db.collection('content_packs').doc(id);
  if (!(await ref.get()).exists) return sendError(res, 404, 'PACK_NAO_ENCONTRADO');

  const allowed = ['name', 'description', 'price', 'currency', 'coverUrl', 'tags', 'enabled', 'order'];
  const update  = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key];
  }

  await ref.update(update);
  contentEngine.invalidate();
  events.emit('content.pack_updated', { packId: id });
  logger.info({ packId: id }, 'content_pack_updated');
  return res.json({ ok: true, id });
}));

// DELETE /content/packs/:id — desabilita pack (soft) ou remove (hard com ?hard=true)
router.delete('/content/packs/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db   = getDb();
  if (!db) return sendError(res, 503, 'DB_INDISPONIVEL');

  const { id } = req.params;
  const hard   = req.query.hard === 'true';

  if (hard) {
    await db.collection('content_packs').doc(id).delete();
    logger.info({ packId: id }, 'content_pack_deleted_hard');
  } else {
    await db.collection('content_packs').doc(id).update({
      enabled:   false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info({ packId: id }, 'content_pack_disabled');
  }

  contentEngine.invalidate();
  events.emit('content.pack_deleted', { packId: id, hard });
  return res.json({ ok: true, id, hard });
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
