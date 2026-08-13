'use strict';

/**
 * routes/quickRitual.js — Quick Ritual e Duo Mode (Entre Sessões)
 *
 * POST /game/quick-ritual/start
 *   mode: 'quick' — solo, 4 cartas, 2–7 min
 *   mode: 'duo'   — 2 jogadores, 5 cartas + invite link automático
 *
 * Cria a sala, inicializa o estado do ritual e retorna tudo que o cliente
 * precisa para conectar via socket.io e jogar imediatamente. Não requer
 * chamada separada a /game/ritual/start.
 *
 * Deck: sempre inclui a carta do Ritual do Dia (se existir) + cartas
 * aleatórias do pool básico até completar o count.
 */

const express = require('express');
const admin   = require('firebase-admin');
const { asyncHandler, sendError } = require('../utils');
const { getOrCreatePanelRoom }    = require('../game/rooms');
const { broadcastPanelUpdate }    = require('../game/state');
const { signHostToken }           = require('../services/auth');
const inviteLinks                 = require('../services/inviteLinks');
const { getDb }                   = require('../services/firestore');
const contentEngine               = require('../services/contentEngine');
const liveService                 = require('../services/liveService');
const events                      = require('../services/events');
const { GameEngine }              = require('../game/engine');
const { logInfo }                 = require('../logger');

const router = express.Router();
const engine = new GameEngine('ritual');

const QUICK_CARD_COUNT = 4;
const DUO_CARD_COUNT   = 5;

async function getUid(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
             || req.body?.firebaseIdToken || '';
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; } catch (_) { return null; }
}

async function buildQuickDeck(count) {
  const [basicRes, dailyRes] = await Promise.allSettled([
    contentEngine.getBasicCards(),
    liveService.getDailyRitual(),
  ]);

  const basicCards  = basicRes.status  === 'fulfilled' ? (basicRes.value  || []) : [];
  const dailyRitual = dailyRes.status  === 'fulfilled' ? dailyRes.value           : null;

  // Carta do ritual do dia entra primeiro (garante presença no deck curto)
  const dailyCard = dailyRitual?.cardTitle
    ? basicCards.find(c => c.title === dailyRitual.cardTitle) || null
    : null;

  const pool = dailyCard
    ? [dailyCard, ...basicCards.filter(c => c.title !== dailyCard.title)]
    : [...basicCards];

  // Shuffle Fisher-Yates (apenas a parte pós-daily)
  const offset = dailyCard ? 1 : 0;
  for (let i = pool.length - 1; i > offset; i--) {
    const j = offset + Math.floor(Math.random() * (i - offset + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count).map(c => engine.sanitizeCard(c)).filter(Boolean);
}

// ── POST /game/quick-ritual/start ─────────────────────────────────────────────

router.post('/game/quick-ritual/start', asyncHandler(async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return sendError(res, 401, 'TOKEN_INVALIDO');

  const mode = String(req.body?.mode || 'quick');
  if (!['quick', 'duo'].includes(mode)) return sendError(res, 400, 'MODE_INVALIDO');

  const maxPlayers = mode === 'duo' ? 2 : 1;
  const cardCount  = mode === 'duo' ? DUO_CARD_COUNT : QUICK_CARD_COUNT;
  const roomName   = mode === 'duo' ? 'Dois Lugares' : 'Quick Ritual';

  // Gera roomId único (não colide com salas normais pelo prefixo)
  const roomId = `${mode}-${uid.slice(0, 8)}-${Date.now().toString(36)}`;

  // Cria sala em memória (panelRooms) — mesma estrutura que /game/room/create
  getOrCreatePanelRoom(roomId, roomName, uid);
  broadcastPanelUpdate();

  let hostToken = null;
  try { hostToken = signHostToken(roomId); } catch (_) {}

  // Deck curto
  const deck = await buildQuickDeck(cardCount);

  // Firestore: sala + ritual state + sessão inicial
  const db = getDb();
  const now = admin.firestore.FieldValue.serverTimestamp();

  let sessionId = `qr-${Date.now()}`;

  if (db) {
    const sessRef = db.collection('salas').doc(roomId).collection('sessions').doc();
    sessionId = sessRef.id;

    // Sala
    await db.collection('salas').doc(roomId).set({
      name:             roomName,
      mode,
      maxPlayers,
      public:           false,
      createdBy:        uid,
      arenaActive:      true,
      currentSessionId: sessionId,
      tags:             ['curto'],
      createdAt:        now,
      updatedAt:        now,
    }).catch(() => {});

    // Estado do ritual
    await db.collection('salas').doc(roomId)
      .collection('ritual').doc('state').set({
        started:            true,
        remainingDeck:      deck,
        currentCard:        null,
        activeEffect:       null,
        pendingDeathrattle: null,
        cardsRevealedCount: 0,
        sessionId,
        updatedAt:          now,
        updatedBy:          'server',
        sessionStartedAt:   Date.now(),
      }).catch(() => {});

    // Sessão
    await sessRef.set({
      sessionId,
      roomId,
      hostId:    uid,
      status:    'active',
      createdAt: now,
      players:   [{ playerId: uid, userId: uid, nickname: 'Host' }],
      gameState: { cardsRevealedCount: 0, currentCardTitle: null, phase: 'playing' },
    }).catch(() => {});

    sessRef.collection('events')
      .add({ type: 'SESSION_STARTED', ts: now, actor: 'server', payload: { mode } })
      .catch(() => {});
  }

  events.emit('ritual.started', {
    roomId, sessionId, hostUid: uid,
    deckSize: deck.length, playerCount: 1, mode,
    players: [{ id: uid, name: 'Host' }],
  }, { persist: true });

  // Duo: gera invite link automático (1 uso, expira em 1h)
  let inviteCode = null;
  if (mode === 'duo' && db) {
    const invite = await inviteLinks.createInvite(roomId, uid, { ttlHours: 1, maxUses: 1 }).catch(() => null);
    inviteCode = invite?.code ?? null;
  }

  logInfo('quick_ritual_started', { roomId, mode, deckSize: deck.length, uid: uid.slice(0, 8) });

  return res.status(201).json({
    ok:         true,
    roomId,
    hostToken,
    sessionId,
    mode,
    deckSize:   deck.length,
    deck,
    inviteCode,
  });
}));

module.exports = router;
