const express = require("express");
const admin   = require("firebase-admin");
const { getDb }                         = require("../services/firestore");
const { verifyHostToken }               = require("../services/auth");
const { panelRooms }                    = require("../game/state");

// Retorna o playerName verificado a partir do panelRooms (imune a spoofing do body).
function resolvedPlayerName(roomId, uid, fallback) {
  return panelRooms.get(roomId)?.players?.[uid]?.playerName
    || String(fallback || "Jogador").slice(0, 80);
}
const { levelFromXP, OSL_BASIC_CARDS } = require("../data/cards");
const contentEngine = require("../services/contentEngine");
const { logInfo, logWarn }              = require("../logger");
const { asyncHandler, sendError }       = require("../utils");
const events                            = require("../services/events");
const entitlements                      = require("../services/entitlements");
const { GameEngine }                    = require("../game/engine");
const adaptiveEngine                    = require("../services/adaptiveEngine");
const liveService                       = require("../services/liveService");
const reputation                        = require("../services/reputation");

const router = express.Router();
const engine = new GameEngine('ritual');

function playableCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.filter(card => (
    card
    && typeof card === 'object'
    && typeof card.title === 'string'
    && card.title.trim()
    && typeof card.text === 'string'
    && card.text.trim()
  ));
}

// Invariante do ritual: nunca persiste started=true com um deck vazio/inválido.
// Preserva primeiro o deck anterior à etapa opcional; em último caso usa as
// cartas básicas embaralhadas pelo próprio GameEngine.
function ensurePlayableDeck(candidate, previousDeck, stage) {
  const playableCandidate = playableCards(candidate);
  if (playableCandidate.length > 0) return playableCandidate;

  const playablePrevious = playableCards(previousDeck);
  if (playablePrevious.length > 0) {
    logWarn('ritual_deck_stage_fallback', { stage, deckSize: playablePrevious.length });
    return playablePrevious;
  }

  const { deck: staticDeck } = engine.buildDeck({
    basicCards: playableCards(OSL_BASIC_CARDS),
    packCards: [],
    customContributions: [],
  });
  const playableStatic = playableCards(staticDeck);
  if (playableStatic.length === 0) {
    throw new Error('RITUAL_DECK_EMPTY');
  }

  logWarn('ritual_deck_static_fallback', { stage, deckSize: playableStatic.length });
  return playableStatic;
}

async function buildVerifiedDeck(db, firebaseIdToken, players) {
  // Resolve uid do host a partir do Firebase ID token
  let hostUid = null;
  if (firebaseIdToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
      hostUid = decoded.uid;
    } catch (_) { /* token inválido — sem pacotes extras */ }
  }

  // Entitlements do host via serviço centralizado (cached, uma leitura Firestore)
  const ent = hostUid ? await entitlements.getUserEntitlements(hostUid) : null;
  const unlockedPacks = ent?.unlockedPacks ?? [];

  // Pack IDs de temporada/eventos ativos (cache, não bloqueia em falha)
  const livePackIds   = await liveService.getLivePackIds().catch(() => []);
  const allPackIds    = [...new Set([...unlockedPacks, ...livePackIds])];

  // Conteúdo via ContentEngine (Firestore > fallback estático, cached 5min)
  const [basicCards, packCards] = await Promise.all([
    contentEngine.getBasicCards(),
    contentEngine.getCardsByPackIds(allPackIds),
  ]);

  // Cartas customizadas dos jogadores (carregadas do Firestore — não do cliente)
  const customContributions = [];
  for (const p of players) {
    if (p.userId && p.activeDeckId) {
      try {
        const snap = await db.collection("users").doc(p.userId).collection("decks").doc(p.activeDeckId).get();
        if (snap.exists) {
          const cards = (snap.data().cards || []).map(c => engine.sanitizeCard(c)).filter(Boolean).slice(0, 50);
          customContributions.push(...cards);
        }
      } catch (_) {}
    }
  }

  return engine.buildDeck({ basicCards, packCards, customContributions });
}

function sanitizePlayers(players) {
  if (!Array.isArray(players)) return [];
  const seen = new Set();
  return players.slice(0, 20).map(p => ({
    id:   String(p.id   || "").trim().slice(0, 100),
    name: String(p.name || "Jogador").trim().slice(0, 80),
  })).filter(p => p.id && !seen.has(p.id) && seen.add(p.id));
}

// O array vindo do navegador serve apenas para indicar o roster visível. A
// ligação com a conta e com o deck é sempre reconstruída de fontes que já
// validaram o Firebase UID: panelRooms e membership Firestore da sala.
async function resolveSessionPlayers(db, roomId, rawPlayers) {
  const players = sanitizePlayers(rawPlayers);
  if (!players.length) return [];

  const panelPlayers = panelRooms.get(roomId)?.players || {};
  const refs = players.map(p => db.collection("salas").doc(roomId).collection("players").doc(p.id));
  const snaps = await db.getAll(...refs).catch(() => []);
  const membershipById = new Map(snaps.filter(Boolean).map(snap => [snap.id, snap.exists ? snap.data() : null]));

  return players.map(player => {
    const panelPlayer = panelPlayers[player.id] || null;
    const membership  = membershipById.get(player.id) || null;
    const panelUid     = String(panelPlayer?.userId || "").trim();
    const memberUid    = String(membership?.userId || "").trim();
    const userId       = panelUid === player.id
      ? panelUid
      : (memberUid === player.id ? memberUid : null);

    return {
      id: player.id,
      name: String(panelPlayer?.playerName || membership?.name || player.name || "Jogador").slice(0, 80),
      userId,
      activeDeckId: userId && membership?.activeDeckId
        ? String(membership.activeDeckId).slice(0, 120)
        : null,
    };
  });
}

async function verifyRoomHost(db, roomId, hostUid) {
  if (!hostUid) return false;
  const roomSnap = await db.collection("salas").doc(roomId).get().catch(() => null);
  if (!roomSnap?.exists) return false;
  const expectedHostUid = String(roomSnap.data()?.hostId || "").trim();
  return !expectedHostUid || expectedHostUid === hostUid;
}

// Sanitiza payload de evento: apenas primitivos, chaves ≤50 chars, strings ≤500 chars
function sanitizeEventPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k.length > 50) continue;
    if (typeof v === "string")                                       safe[k] = v.slice(0, 500);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) safe[k] = v;
  }
  return safe;
}

// Helper: adiciona evento à sessão de forma fire-and-forget (não bloqueia resposta)
function logSessionEvent(db, roomId, sessionId, type, actor, payload = {}) {
  if (!sessionId) return;
  const now = admin.firestore.FieldValue.serverTimestamp();
  db.collection("salas").doc(roomId)
    .collection("sessions").doc(sessionId)
    .collection("events")
    .add({ type, ts: now, actor, payload })
    .catch(() => {});
}

// ── POST /game/ritual/start ───────────────────────────────────────────────────
router.post("/game/ritual/start", asyncHandler(async (req, res) => {
  const { roomId, hostToken, firebaseIdToken, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_start_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const hostUid = await uidFromFirebaseToken(firebaseIdToken);
  if (!await verifyRoomHost(db, roomId, hostUid)) {
    return sendError(res, 403, "ANFITRIAO_NAO_AUTORIZADO");
  }

  const players = await resolveSessionPlayers(db, roomId, rawPlayers);

  const existingRoomSnap = await db.collection("salas").doc(roomId).get();
  if (!existingRoomSnap.exists) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
  if (String(existingRoomSnap.data()?.hostId || "").trim() !== hostUid) {
    return sendError(res, 403, "ANFITRIAO_NAO_AUTORIZADO");
  }
  const existingSessionId = String(existingRoomSnap.data()?.currentSessionId || "").trim();
  if (existingSessionId) {
    return res.json({ ok: true, alreadyStarted: true, sessionId: existingSessionId });
  }
  const { deck: rawDeck } = await buildVerifiedDeck(db, firebaseIdToken || null, players);
  let deck = await adaptiveEngine.reorderDeck(rawDeck, { roomId, hostUid });
  deck = ensurePlayableDeck(deck, rawDeck, 'start:adaptive');

  // Priming contextual — Pipeline: temporal + grupo + mundo + estilo host
  // Feature flag: contextual_selection_v1 | Fallback: deck original
  try {
    const playerContext       = require('../services/playerContext');
    const contextualSelection = require('../services/contextualSelection');
    const ctx = await playerContext.buildSessionContext({ hostUid, players, roomId });
    deck = await contextualSelection.applyPriming(deck, ctx, { roomId, hostUid });
  } catch (_) {}

  deck = ensurePlayableDeck(deck, rawDeck, 'start:final');

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  const roomRef = db.collection("salas").doc(roomId);

  // Gera session antes de escrever o ritual para incluir sessionId no doc
  const sessRef   = db.collection("salas").doc(roomId).collection("sessions").doc();
  const sessionId = sessRef.id;
  const startedEventRef = sessRef.collection("events").doc();
  const historyRef = ritualRef.collection("history").doc();

  let reservation;
  try {
    reservation = await db.runTransaction(async tx => {
    const freshRoomSnap = await tx.get(roomRef);
    if (!freshRoomSnap.exists) throw Object.assign(new Error("SALA_NAO_ENCONTRADA"), { code: "room-missing" });
    const freshRoom = freshRoomSnap.data() || {};
    if (String(freshRoom.hostId || "") !== hostUid) {
      throw Object.assign(new Error("ANFITRIAO_NAO_AUTORIZADO"), { code: "host-changed" });
    }
    const activeSessionId = String(freshRoom.currentSessionId || "").trim();
    if (activeSessionId) return { existingSessionId: activeSessionId };

    const reservedDeck = deck.slice();
    const fragmentEngine = require('../services/fragmentEngine');
    const fragment = await fragmentEngine.claimFragmentInTransaction(tx, hostUid, db);
    if (fragment) {
      const position = Math.max(1, Math.floor(reservedDeck.length / 3));
      reservedDeck.splice(position, 0, fragment);
    }

    tx.set(ritualRef, {
      started: true,
      remainingDeck: reservedDeck,
      currentCard: null,
      activeEffect: null,
      pendingDeathrattle: null,
      cardsRevealedCount: 0,
      sessionId,
      updatedAt: now,
      updatedBy: "server",
      sessionStartedAt: Date.now(),
    });
    tx.set(sessRef, {
      sessionId,
      roomId,
      hostId: hostUid,
      status: "active",
      createdAt: now,
      players: players.map(p => ({ playerId: p.id, userId: p.userId || null, nickname: p.name })),
      gameState: { cardsRevealedCount: 0, currentCardTitle: null, phase: "playing" },
    });
    tx.set(startedEventRef, {
      type: "SESSION_STARTED",
      ts: now,
      actor: "server",
      payload: {},
    });
    tx.set(historyRef, {
      type: "Ritual",
      text: "O ritual foi iniciado.",
      createdAt: now,
    });
    tx.update(roomRef, {
      status: "started",
      arenaActive: true,
      currentSessionId: sessionId,
      updatedAt: now,
    });
      return { existingSessionId: null, deck: reservedDeck };
    });
  } catch (error) {
    if (error?.code === "room-missing") return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    if (error?.code === "host-changed") return sendError(res, 403, "ANFITRIAO_NAO_AUTORIZADO");
    throw error;
  }

  if (reservation.existingSessionId) {
    return res.json({ ok: true, alreadyStarted: true, sessionId: reservation.existingSessionId });
  }
  deck = reservation.deck;

  events.emit('ritual.started', {
    roomId, sessionId, hostUid: hostUid || null,
    deckSize: deck.length,
    playerCount: players.length,
    players: players.map(p => ({ id: p.id, userId: p.userId || null, name: p.name })),
  }, { persist: true });

  logInfo("ritual_started", { roomId, deckSize: deck.length, sessionId });
  return res.json({ ok: true, deckSize: deck.length, sessionId });
}));

// ── POST /game/ritual/next-card ───────────────────────────────────────────────
router.post("/game/ritual/next-card", asyncHandler(async (req, res) => {
  const {
    roomId,
    hostToken,
    players: rawPlayers,
    commandId: rawCommandId,
    expectedCardsRevealedCount: rawExpectedCardsRevealedCount,
  } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_next_card_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const commandId = String(rawCommandId || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(commandId)) {
    return sendError(res, 400, "COMMAND_ID_INVALIDO");
  }
  const expectedCardsRevealedCount = Number(rawExpectedCardsRevealedCount);
  if (!Number.isInteger(expectedCardsRevealedCount) || expectedCardsRevealedCount < 0) {
    return sendError(res, 400, "EXPECTED_CARDS_REVEALED_COUNT_INVALIDO");
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const players = sanitizePlayers(rawPlayers);
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  const commandRef = ritualRef.collection("commands").doc(commandId);
  const historyRef = ritualRef.collection("history").doc(`card_${commandId}`);
  const platformEventRef = db.collection("platform_events").doc();
  let effectsMapPromise = null;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const eventTs = Date.now();

  const outcome = await db.runTransaction(async tx => {
    const [commandSnap, ritualSnap] = await Promise.all([
      tx.get(commandRef),
      tx.get(ritualRef),
    ]);

    if (commandSnap.exists) {
      const previous = commandSnap.data() || {};
      const currentSessionId = String(ritualSnap.data()?.sessionId || "").trim() || null;
      if (
        Number(previous.expectedCardsRevealedCount) !== expectedCardsRevealedCount
        || (previous.sessionId || null) !== currentSessionId
      ) {
        return { status: "command-reused" };
      }
      return { status: "replayed", response: previous.response || null };
    }
    if (!ritualSnap.exists || ritualSnap.data()?.started !== true) {
      return { status: "not-started" };
    }

    const data = ritualSnap.data() || {};
    const storedCount = Number(data.cardsRevealedCount);
    const currentCount = Number.isInteger(storedCount) && storedCount >= 0 ? storedCount : 0;
    if (currentCount !== expectedCardsRevealedCount) {
      return { status: "count-conflict", currentCount };
    }

    const deck = Array.isArray(data.remainingDeck) ? [...data.remainingDeck] : [];
    if (!deck.length) return { status: "empty-deck", currentCount };

    const card = deck.shift();
    const cardsRevealedCount = currentCount + 1;
    if (!effectsMapPromise) effectsMapPromise = contentEngine.getCardEffectsMap();
    const effectsMap = await effectsMapPromise;
    const { battlecry, deathrattle } = engine.prepareCard(card, players, effectsMap);
    const currentSessionId = String(data.sessionId || "").trim() || null;
    const eventPayload = {
      roomId,
      sessionId: currentSessionId,
      cardTitle: card.title || null,
      cardType: card.type || null,
      cardId: card.id || null,
      hasEffect: !!battlecry,
      effectType: battlecry?.type || null,
      cardsRevealedCount,
      remaining: deck.length,
      commandId,
    };
    const response = {
      ok: true,
      commandId,
      card,
      cardsRevealedCount,
      remaining: deck.length,
    };

    let sessRef = null;
    let sessionSnap = null;
    if (currentSessionId) {
      sessRef = db.collection("salas").doc(roomId).collection("sessions").doc(currentSessionId);
      sessionSnap = await tx.get(sessRef);
    }

    tx.set(ritualRef, {
      started: true,
      remainingDeck: deck,
      currentCard: card,
      activeEffect: battlecry || null,
      pendingDeathrattle: deathrattle || null,
      cardsRevealedCount,
      updatedAt: now,
      updatedBy: "server",
    }, { merge: true });
    tx.create(commandRef, {
      type: "ritual.next-card",
      commandId,
      sessionId: currentSessionId,
      expectedCardsRevealedCount,
      response,
      createdAt: now,
    });
    tx.create(historyRef, {
      type: card.type || "Ritual",
      text: card.title || "Carta",
      commandId,
      createdAt: now,
    });
    tx.create(platformEventRef, {
      topic: "ritual.card_revealed",
      payload: eventPayload,
      ts: eventTs,
      createdAt: now,
    });

    if (sessRef && sessionSnap?.exists) {
      const sessionEventRef = sessRef.collection("events").doc(`card_${commandId}`);
      tx.create(sessionEventRef, {
        type: "CARD_REVEALED",
        ts: now,
        actor: "server",
        commandId,
        payload: {
          title: card.title || null,
          type: card.type || null,
          count: cardsRevealedCount,
        },
      });
      if (battlecry) {
        const effectEventRef = sessRef.collection("events").doc(`effect_${commandId}`);
        tx.create(effectEventRef, {
          type: "EFFECT_TRIGGERED",
          ts: now,
          actor: "server",
          commandId,
          payload: {
            effectId: battlecry.id,
            effectType: battlecry.type,
            phase: "battlecry",
            cardTitle: card.title || null,
          },
        });
      }
      tx.update(sessRef, {
        gameState: {
          cardsRevealedCount,
          currentCardTitle: card.title || null,
          phase: "playing",
        },
      });
    }

    return { status: "applied", response, eventPayload };
  });

  if (outcome.status === "not-started") return sendError(res, 404, "RITUAL_NAO_INICIADO");
  if (outcome.status === "empty-deck") {
    return res.status(409).json({ ok: false, error: "DECK_VAZIO", cardsRevealedCount: outcome.currentCount });
  }
  if (outcome.status === "count-conflict") {
    return res.status(409).json({
      ok: false,
      error: "CARDS_REVEALED_COUNT_DIVERGIU",
      expectedCardsRevealedCount,
      cardsRevealedCount: outcome.currentCount,
    });
  }
  if (outcome.status === "command-reused") {
    return res.status(409).json({ ok: false, error: "COMMAND_ID_REUTILIZADO", commandId });
  }
  if (outcome.status === "replayed") {
    if (!outcome.response) return sendError(res, 409, "COMMAND_RESULT_INDISPONIVEL");
    return res.json({ ...outcome.response, alreadyApplied: true });
  }

  events.emit("ritual.card_revealed", outcome.eventPayload);
  logInfo("ritual_next_card", {
    roomId,
    commandId,
    cardTitle: outcome.response.card?.title || null,
    cardsRevealedCount: outcome.response.cardsRevealedCount,
    remaining: outcome.response.remaining,
  });
  return res.json({ ...outcome.response, alreadyApplied: false });
}));

// ── POST /game/ritual/reset ───────────────────────────────────────────────────
router.post("/game/ritual/reset", asyncHandler(async (req, res) => {
  const { roomId, hostToken, firebaseIdToken, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_reset_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  const roomRef = db.collection("salas").doc(roomId);

  const hostUid = await uidFromFirebaseToken(firebaseIdToken);
  if (!await verifyRoomHost(db, roomId, hostUid)) {
    return sendError(res, 403, "ANFITRIAO_NAO_AUTORIZADO");
  }
  const players = await resolveSessionPlayers(db, roomId, rawPlayers);

  // Captura a sessão esperada antes de preparar o novo deck. A transação
  // abaixo relê e compara esse valor, portanto uma segunda chamada concorrente
  // nunca encerra a sessão que acabou de ser criada pela primeira.
  const [oldSnap, roomBeforeSnap, { deck: rawDeck }] = await Promise.all([
    ritualRef.get(),
    roomRef.get(),
    buildVerifiedDeck(db, firebaseIdToken || null, players),
  ]);
  if (!roomBeforeSnap.exists) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
  const ritualSessionId = oldSnap.exists ? String(oldSnap.data()?.sessionId || "").trim() : "";
  const roomSessionIdBefore = String(roomBeforeSnap.data()?.currentSessionId || "").trim();
  if (ritualSessionId && roomSessionIdBefore && ritualSessionId !== roomSessionIdBefore) {
    return sendError(res, 409, "ESTADO_DE_SESSAO_INCONSISTENTE");
  }
  const oldSessionId = roomSessionIdBefore || ritualSessionId || null;
  let deck = await adaptiveEngine.reorderDeck(rawDeck, { roomId, hostUid });
  deck = ensurePlayableDeck(deck, rawDeck, 'reset:adaptive');

  // Priming contextual — Pipeline: temporal + grupo + mundo + estilo host
  try {
    const playerContext       = require('../services/playerContext');
    const contextualSelection = require('../services/contextualSelection');
    const ctx = await playerContext.buildSessionContext({ hostUid, players, roomId });
    deck = await contextualSelection.applyPriming(deck, ctx, { roomId, hostUid });
  } catch (_) {}

  deck = ensurePlayableDeck(deck, rawDeck, 'reset:final');

  const now = admin.firestore.FieldValue.serverTimestamp();

  // Gera nova sessão
  const sessRef   = db.collection("salas").doc(roomId).collection("sessions").doc();
  const sessionId = sessRef.id;
  const oldSessRef = oldSessionId
    ? db.collection("salas").doc(roomId).collection("sessions").doc(oldSessionId)
    : null;
  const startedEventRef = sessRef.collection("events").doc();
  const resetEventRef = oldSessRef ? oldSessRef.collection("events").doc() : null;
  const historyRef = ritualRef.collection("history").doc();

  let reservation;
  try {
    reservation = await db.runTransaction(async tx => {
      const reads = [tx.get(roomRef), tx.get(ritualRef)];
      if (oldSessRef) reads.push(tx.get(oldSessRef));
      const [freshRoomSnap, freshRitualSnap, freshOldSessionSnap] = await Promise.all(reads);
      if (!freshRoomSnap.exists) throw Object.assign(new Error("SALA_NAO_ENCONTRADA"), { code: "room-missing" });
      const freshRoom = freshRoomSnap.data() || {};
      if (String(freshRoom.hostId || "") !== hostUid) {
        throw Object.assign(new Error("ANFITRIAO_NAO_AUTORIZADO"), { code: "host-changed" });
      }

      const freshRitualSessionId = String(freshRitualSnap.data()?.sessionId || "").trim();
      if (freshRitualSessionId && freshRitualSessionId !== String(oldSessionId || "")) {
        return { existingSessionId: freshRitualSessionId };
      }
      const roomSessionId = String(freshRoom.currentSessionId || "").trim();
      if (roomSessionId && roomSessionId !== String(oldSessionId || "")) {
        return { existingSessionId: roomSessionId };
      }
      const oldSessionStatus = freshOldSessionSnap?.exists
        ? String(freshOldSessionSnap.data()?.status || "").trim()
        : "";
      if (oldSessionStatus && !["active", "ended"].includes(oldSessionStatus)) {
        throw Object.assign(new Error("SESSAO_NAO_PODE_SER_REINICIADA"), { code: "session-invalid-status" });
      }
      if (oldSessionStatus === "active") {
        throw Object.assign(new Error("SESSAO_ATIVA_PRECISA_SER_ENCERRADA"), { code: "session-still-active" });
      }

      const reservedDeck = deck.slice();
      const fragmentEngine = require('../services/fragmentEngine');
      const fragment = await fragmentEngine.claimFragmentInTransaction(tx, hostUid, db);
      if (fragment) {
        const position = Math.max(1, Math.floor(reservedDeck.length / 3));
        reservedDeck.splice(position, 0, fragment);
      }

      tx.set(ritualRef, {
        started: true,
        remainingDeck: reservedDeck,
        currentCard: null,
        activeEffect: null,
        pendingDeathrattle: null,
        cardsRevealedCount: 0,
        sessionId,
        updatedAt: now,
        updatedBy: "server",
        sessionStartedAt: Date.now(),
      }, { merge: true });
      tx.set(sessRef, {
        sessionId,
        roomId,
        hostId: hostUid,
        status: "active",
        createdAt: now,
        players: players.map(p => ({ playerId: p.id, userId: p.userId || null, nickname: p.name })),
        gameState: { cardsRevealedCount: 0, currentCardTitle: null, phase: "playing" },
      });
      tx.set(startedEventRef, {
        type: "SESSION_STARTED",
        ts: now,
        actor: "server",
        payload: {},
      });
      if (resetEventRef && freshOldSessionSnap?.exists) {
        tx.set(resetEventRef, {
          type: "GAME_RESET",
          ts: now,
          actor: "server",
          payload: {},
        });
      }
      tx.set(historyRef, {
        type: "Ritual",
        text: "O ritual foi reiniciado.",
        createdAt: now,
      });
      tx.update(roomRef, {
        status: "started",
        arenaActive: true,
        currentSessionId: sessionId,
        updatedAt: now,
      });
      return { existingSessionId: null, deck: reservedDeck };
    });
  } catch (error) {
    if (error?.code === "room-missing") return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    if (error?.code === "host-changed") return sendError(res, 403, "ANFITRIAO_NAO_AUTORIZADO");
    if (error?.code === "session-invalid-status") return sendError(res, 409, "SESSAO_NAO_PODE_SER_REINICIADA");
    if (error?.code === "session-still-active") return sendError(res, 409, "SESSAO_ATIVA_PRECISA_SER_ENCERRADA");
    throw error;
  }

  if (reservation.existingSessionId) {
    return res.json({ ok: true, alreadyReset: true, sessionId: reservation.existingSessionId });
  }
  deck = reservation.deck;

  logInfo("ritual_reset", { roomId, deckSize: deck.length, sessionId });
  return res.json({ ok: true, deckSize: deck.length, sessionId });
}));

// ── Helpers de autenticação de participantes ──────────────────────────────────

async function uidFromFirebaseToken(firebaseIdToken) {
  if (!firebaseIdToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
    return decoded.uid;
  } catch (_) { return null; }
}

async function verifyParticipant(db, roomId, participantId) {
  if (!participantId) return null;
  try {
    const snap = await db.collection("salas").doc(roomId).collection("players").doc(participantId).get();
    return snap.exists ? participantId : null;
  } catch (_) { return null; }
}

async function resolveParticipantId(db, roomId, firebaseIdToken, participantId) {
  // Um token válido prova a conta, mas não prova sozinho que ela pertence a
  // esta sala. A membership Firestore fecha esse segundo elo.
  const uid = await uidFromFirebaseToken(firebaseIdToken);
  if (uid) return verifyParticipant(db, roomId, uid);
  // Fallback: verifica se o participantId está na coleção de players da sala.
  return verifyParticipant(db, roomId, participantId);
}

// ── POST /game/ritual/vote ────────────────────────────────────────────────────
router.post("/game/ritual/vote", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, option, sessionId } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const safeOption = String(option || "").slice(0, 100);
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  try {
    await ritualRef.update({ [`activeEffect.votes.${uid}`]: safeOption });
  } catch (_) { /* documento não existe ainda — ignora silenciosamente */ }

  logSessionEvent(db, roomId, sessionId, "VOTE_CAST", uid, { option: safeOption });
  events.emit('ritual.vote_cast', { roomId, sessionId, uid, option: safeOption });

  return res.json({ ok: true });
}));

// ── POST /game/ritual/react ───────────────────────────────────────────────────
router.post("/game/ritual/react", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, emoji, playerName, sessionId } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const safeEmoji  = String(emoji || "👋").slice(0, 8);
  const safeName   = resolvedPlayerName(roomId, uid, playerName);
  const ts = Date.now();

  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  await ritualRef.set({
    [`reactions.${uid}`]:      { emoji: safeEmoji, name: safeName, ts },
    [`reactionCounts.${uid}`]: admin.firestore.FieldValue.increment(1)
  }, { merge: true });

  logSessionEvent(db, roomId, sessionId, "REACTION_SENT", uid, { emoji: safeEmoji, name: safeName });
  events.emit('ritual.reaction_sent', { roomId, sessionId, uid, emoji: safeEmoji });

  return res.json({ ok: true, ts });
}));

// ── POST /game/ritual/ai-detect ───────────────────────────────────────────────
router.post("/game/ritual/ai-detect", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, source, playerName, message, sessionId } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const validSources = ["voice", "chat"];
  const safeSource   = validSources.includes(source) ? source : "chat";
  const safeName     = resolvedPlayerName(roomId, uid, playerName);
  const safeMessage  = message ? String(message).slice(0, 500) : null;

  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  await ritualRef.set({
    aiDetection: { source: safeSource, playerName: safeName, message: safeMessage, detectedAt: Date.now() }
  }, { merge: true });

  logSessionEvent(db, roomId, sessionId, "AI_DETECTION_TRIGGERED", uid, { source: safeSource, playerName: safeName });

  return res.json({ ok: true });
}));

// ── POST /game/ritual/social-pressure ────────────────────────────────────────
router.post("/game/ritual/social-pressure", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, playerName, sessionId } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const safeName = resolvedPlayerName(roomId, uid, playerName);

  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  await ritualRef.set({
    socialPressure: { ts: Date.now(), votedBy: safeName, roomCode: String(roomId).slice(0, 50) }
  }, { merge: true });

  logSessionEvent(db, roomId, sessionId, "SOCIAL_PRESSURE_TRIGGERED", uid, { nickname: safeName });

  return res.json({ ok: true });
}));

// ── POST /game/ritual/resolve-effect (host only) ──────────────────────────────
router.post("/game/ritual/resolve-effect", asyncHandler(async (req, res) => {
  const { roomId, hostToken, winner, dismissOnly, sessionId } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_resolve_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");

  if (dismissOnly) {
    // dismissAIDetection: limpa aiDetection sem resolver o efeito ativo
    await ritualRef.set({ aiDetection: null }, { merge: true });
    logSessionEvent(db, roomId, sessionId, "AI_DETECTION_DISMISSED", "server", {});
  } else {
    // resolveActiveEffect: limpa efeito ativo + AI detection + registra voto vencedor
    const update = { activeEffect: null, aiDetection: null };
    if (winner) update.voteResult = { winner: String(winner).slice(0, 200), resolvedAt: Date.now() };
    await ritualRef.set(update, { merge: true });
    logSessionEvent(db, roomId, sessionId, "EFFECT_RESOLVED", "server", { winner: winner || null });
  }

  logInfo("ritual_resolve_effect", { roomId, winner: winner || null, dismissOnly: !!dismissOnly });
  return res.json({ ok: true });
}));

// ── POST /game/session/log-event ─────────────────────────────────────────────
// Eventos gerados pelo cliente com allowlist estrita. Não substitui logs server-side.
const CLIENT_LOGGABLE_EVENTS = new Set(["PLAYER_LEFT", "MISSION_COMPLETED"]);

router.post("/game/session/log-event", asyncHandler(async (req, res) => {
  const { roomId, sessionId, participantId, firebaseIdToken, type, payload } = req.body || {};
  if (!roomId || !sessionId || !type) return sendError(res, 400, "CAMPOS_OBRIGATORIOS");
  if (!CLIENT_LOGGABLE_EVENTS.has(type)) return sendError(res, 403, "EVENTO_NAO_PERMITIDO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("salas").doc(roomId).collection("sessions").doc(sessionId)
    .collection("events").add({ type, ts: now, actor: uid, payload: sanitizeEventPayload(payload) });

  return res.json({ ok: true });
}));

// ── POST /game/session/player-join ───────────────────────────────────────────
// Registra presença do jogador na sessão. Detecta reconnect automaticamente.
router.post("/game/session/player-join", asyncHandler(async (req, res) => {
  const { roomId, sessionId, participantId, firebaseIdToken, nickname } = req.body || {};
  if (!roomId || !sessionId) return sendError(res, 400, "ROOM_ID_OU_SESSION_ID_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await resolveParticipantId(db, roomId, firebaseIdToken, participantId);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const safeName = resolvedPlayerName(roomId, uid, nickname);
  const now      = admin.firestore.FieldValue.serverTimestamp();
  const sessRef  = db.collection("salas").doc(roomId).collection("sessions").doc(sessionId);
  const sessSnap = await sessRef.get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSION_NAO_ENCONTRADA");

  const playerRef  = sessRef.collection("players").doc(uid);
  const playerSnap = await playerRef.get();
  const isReconnect = playerSnap.exists;

  const playerData = { playerId: uid, nickname: safeName, connected: true, lastSeenAt: now };
  if (!isReconnect) {
    playerData.joinedAt = now;
  } else {
    playerData.reconnectCount    = (playerSnap.data().reconnectCount || 0) + 1;
    playerData.lastReconnectedAt = now;
  }
  await playerRef.set(playerData, { merge: true });

  const eventType = isReconnect ? "PLAYER_RECONNECTED" : "PLAYER_JOINED";
  sessRef.collection("events").add({ type: eventType, ts: now, actor: uid, payload: { nickname: safeName } }).catch(() => {});

  // Notifica todos via room doc (campo efêmero observado pelo bindRoom)
  if (isReconnect) {
    db.collection("salas").doc(roomId).update({
      reconnectNotification: { nickname: safeName, participantId: uid, ts: Date.now() }
    }).catch(() => {});
  }

  return res.json({ ok: true, isReconnect });
}));

// ── POST /game/session/player-heartbeat ──────────────────────────────────────
// Atualiza presença do jogador (conectado/desconectado). Chamado a cada 15s.
router.post("/game/session/player-heartbeat", asyncHandler(async (req, res) => {
  const { roomId, sessionId, firebaseIdToken, connected } = req.body || {};
  if (!roomId || !sessionId) return sendError(res, 400, "ROOM_ID_OU_SESSION_ID_OBRIGATORIO");

  const db  = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const uid = await uidFromFirebaseToken(firebaseIdToken);
  if (!uid) return sendError(res, 403, "PARTICIPANTE_NAO_AUTORIZADO");

  const now = admin.firestore.FieldValue.serverTimestamp();
  db.collection("salas").doc(roomId)
    .collection("sessions").doc(sessionId)
    .collection("players").doc(uid)
    .set({ connected: connected !== false, lastSeenAt: now }, { merge: true })
    .catch(() => {});

  return res.json({ ok: true });
}));

// ── POST /game/session/end-game ──────────────────────────────────────────────
// Encerra a sessão de jogo. Computa summary durável a partir dos eventos.
router.post("/game/session/end-game", asyncHandler(async (req, res) => {
  const { roomId, sessionId, hostToken } = req.body || {};
  if (!roomId || !sessionId) return sendError(res, 400, "ROOM_ID_OU_SESSION_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db  = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const now     = admin.firestore.FieldValue.serverTimestamp();
  const sessRef = db.collection("salas").doc(roomId).collection("sessions").doc(sessionId);
  const roomRef = db.collection("salas").doc(roomId);

  // Lê sessão e eventos em paralelo para computar summary
  const [sessSnap, eventsSnap] = await Promise.all([
    sessRef.get(),
    sessRef.collection("events").get(),
  ]).catch(() => [null, null]);

  if (!sessSnap?.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");

  const sessData       = sessSnap.data();
  const createdMs      = sessData.createdAt?.toMillis?.() || Date.now();
  const sessionPlayers = sessData.players || [];
  const rawEvents      = eventsSnap?.docs?.map(d => d.data()) || [];
  const summary        = sessData.summary
    || engine.computeSummary(rawEvents, { players: sessionPlayers, createdMs });

  // O encerramento pode ter sido confirmado antes de uma queda do processo.
  // Nesse caso repetimos apenas o settlement idempotente das contas: o marker
  // account-v1 impede XP/reputação duplicados e repara uma tentativa incompleta.
  if (sessData.status === "ended") {
    const accountSettlement = await reputation.settleSessionAccounts(
      sessionId,
      roomId,
      summary,
      sessionPlayers.filter(player => player?.userId),
    );
    return res.json({
      ok: true,
      alreadyEnded: true,
      summary,
      accountSettlement,
    });
  }

  const settlement = await db.runTransaction(async tx => {
    const [freshSessionSnap, roomSnap] = await Promise.all([
      tx.get(sessRef),
      tx.get(roomRef),
    ]);

    if (!freshSessionSnap.exists) return { missing: true };
    const freshSession = freshSessionSnap.data();
    if (freshSession.status === "ended") {
      return { alreadyEnded: true, summary: freshSession.summary || null };
    }
    if (freshSession.status !== "active") {
      return { invalidStatus: freshSession.status || "unknown" };
    }

    tx.update(sessRef, {
      status: "ended",
      endedAt: now,
      settledAt: now,
      settlementVersion: 1,
      summary,
    });
    if (roomSnap.exists && roomSnap.data()?.currentSessionId === sessionId) {
      tx.update(roomRef, { currentSessionId: null, updatedAt: now });
    }
    return { alreadyEnded: false };
  });

  if (settlement.missing) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (settlement.invalidStatus) {
    return res.status(409).json({ ok: false, error: "SESSAO_NAO_ATIVA", status: settlement.invalidStatus });
  }
  if (settlement.alreadyEnded) {
    const settledSummary = settlement.summary || summary;
    const accountSettlement = await reputation.settleSessionAccounts(
      sessionId,
      roomId,
      settledSummary,
      sessionPlayers.filter(player => player?.userId),
    );
    return res.json({
      ok: true,
      alreadyEnded: true,
      summary: settledSummary,
      accountSettlement,
    });
  }

  // Progressão de conta é parte obrigatória do settlement e é reparável em
  // qualquer retry do endpoint, independentemente do fan-out de eventos.
  const accountSettlement = await reputation.settleSessionAccounts(
    sessionId,
    roomId,
    summary,
    sessionPlayers.filter(player => player?.userId),
  );

  await sessRef.collection("events").add({
    type: "GAME_ENDED",
    ts: now,
    actor: "server",
    payload: { settlementVersion: 1 },
  });

  await events.emitAsync('session.ended', {
    roomId, sessionId, summary,
    playerCount: sessionPlayers.length,
    players: sessionPlayers,   // [{ playerId, userId, nickname }] — alimenta Social Graph
  }, { persist: true });

  logInfo("session_ended", { roomId, sessionId, cardsRevealed: summary.cardsRevealed, durationSec: summary.durationSec });
  return res.json({ ok: true, alreadyEnded: false, summary, accountSettlement });
}));

// ── GET /game/room/:roomId/sessions ──────────────────────────────────────────
// Lista as últimas sessões encerradas de uma sala (auth: Firebase ID token).
router.get("/game/room/:roomId/sessions", asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!token)  return sendError(res, 401, "TOKEN_OBRIGATORIO");

  try { await admin.auth().verifyIdToken(token); } catch (_) {
    return sendError(res, 403, "TOKEN_INVALIDO");
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const snap = await db.collection("salas").doc(roomId)
    .collection("sessions")
    .orderBy("createdAt", "desc")
    .limit(12)
    .get();

  const sessions = snap.docs
    .map(d => ({ sessionId: d.id, ...d.data() }))
    .filter(s => s.status === "ended")
    .slice(0, 10)
    .map(s => ({
      sessionId:   s.sessionId,
      createdAt:   s.createdAt?.toMillis?.()  || null,
      endedAt:     s.endedAt?.toMillis?.()    || null,
      summary:     s.summary || null,
      playerCount: (s.players || []).length,
    }));

  return res.json({ ok: true, sessions });
}));

module.exports = router;
