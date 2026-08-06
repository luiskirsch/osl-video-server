const express = require("express");
const crypto  = require("crypto");
const admin   = require("firebase-admin");
const { getDb }                         = require("../services/firestore");
const { verifyHostToken }               = require("../services/auth");
const { OSL_CARD_EFFECTS, OSL_BASIC_CARDS } = require("../data/cards");
const { logInfo, logWarn }              = require("../logger");
const { asyncHandler, sendError }       = require("../utils");

const router = express.Router();

function cryptoShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const idx = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
    [a[i], a[idx]] = [a[idx], a[i]];
  }
  return a;
}

function pickRandom(arr) {
  if (!arr?.length) return null;
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

function prepareEffect(effect, players) {
  if (!effect) return null;
  const base = {
    id: crypto.randomBytes(6).toString("hex"),
    type: effect.type,
    phase: effect.phase || "battlecry",
    label: effect.label || null,
    params: {},
    votes: {},
    resolved: false
  };
  switch (effect.type) {
    case "force_player": {
      if (effect.target === "two_random") {
        const shuffled = cryptoShuffle(players.filter(p => p.id));
        const t1 = shuffled[0], t2 = shuffled[1] || shuffled[0];
        base.params = { targetId: t1?.id || "", targetName: t1?.name || "Jogador", targetId2: t2?.id || t1?.id || "", targetName2: t2?.name || t1?.name || "Jogador" };
      } else {
        const pool = players.length > 1 ? players : players;
        const t = pickRandom(pool);
        base.params = { targetId: t?.id || "", targetName: t?.name || "Jogador" };
      }
      break;
    }
    case "set_timer":  { base.params = { duration: effect.duration || 60, startedAt: Date.now() }; break; }
    case "vote":       { base.params = { question: effect.question || "Vote:", options: effect.options || players.map(p => p.name || "Jogador") }; break; }
    case "next_category":
    case "chain_card": { base.params = { category: effect.category || "" }; break; }
    case "give_xp":    { base.params = { amount: effect.amount || 10 }; break; }
  }
  return base;
}

function prepareCard(card, players) {
  if (!card) return { battlecry: null, deathrattle: null };
  const key = card._origTitle || card.title;
  const effects = OSL_CARD_EFFECTS[key] || {};
  return {
    battlecry:   effects.battlecry   ? prepareEffect({ ...effects.battlecry,   phase: "battlecry" },   players) : null,
    deathrattle: effects.deathrattle ? prepareEffect({ ...effects.deathrattle, phase: "deathrattle" }, players) : null,
  };
}

function sanitizeCard(c) {
  if (!c || typeof c !== "object") return null;
  return {
    title:      String(c.title      || "").slice(0, 200),
    type:       String(c.type       || "Ritual").slice(0, 50),
    text:       String(c.text       || "").slice(0, 2000),
    rule:       c.rule      ? String(c.rule).slice(0, 1000)      : undefined,
    subrule:    c.subrule   ? String(c.subrule).slice(0, 1000)   : undefined,
    phrase:     c.phrase    ? String(c.phrase).slice(0, 500)     : undefined,
    _origTitle: c._origTitle ? String(c._origTitle).slice(0, 200) : undefined,
  };
}

function sanitizePlayers(players) {
  if (!Array.isArray(players)) return [];
  return players.slice(0, 20).map(p => ({
    id:   String(p.id   || "").slice(0, 100),
    name: String(p.name || "Jogador").slice(0, 80),
  }));
}

// ── POST /game/ritual/start ───────────────────────────────────────────────────
router.post("/game/ritual/start", asyncHandler(async (req, res) => {
  const { roomId, hostToken, deckCards, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_start_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const deckInput = Array.isArray(deckCards) && deckCards.length > 0 ? deckCards : OSL_BASIC_CARDS;
  const deck = cryptoShuffle(deckInput.map(sanitizeCard).filter(Boolean));

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");

  await ritualRef.set({
    started: true,
    remainingDeck: deck,
    currentCard: null,
    activeEffect: null,
    pendingDeathrattle: null,
    cardsRevealedCount: 0,
    updatedAt: now,
    updatedBy: "server",
    sessionStartedAt: Date.now()
  });

  await ritualRef.collection("history").add({ type: "Ritual", text: "O ritual foi iniciado.", createdAt: now });
  await db.collection("salas").doc(roomId).update({ arenaActive: true, updatedAt: now });

  logInfo("ritual_started", { roomId, deckSize: deck.length });
  return res.json({ ok: true, deckSize: deck.length });
}));

// ── POST /game/ritual/next-card ───────────────────────────────────────────────
router.post("/game/ritual/next-card", asyncHandler(async (req, res) => {
  const { roomId, hostToken, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_next_card_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const players = sanitizePlayers(rawPlayers);
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");
  const snap = await ritualRef.get();

  if (!snap.exists) return sendError(res, 404, "RITUAL_NAO_INICIADO");

  const data = snap.data();
  const deck = Array.isArray(data.remainingDeck) ? [...data.remainingDeck] : [];
  if (!deck.length) return res.status(409).json({ ok: false, error: "DECK_VAZIO" });

  const card = deck.shift();
  const cardsRevealedCount = (data.cardsRevealedCount || 0) + 1;
  const { battlecry, deathrattle } = prepareCard(card, players);

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ritualRef.set({
    started: true,
    remainingDeck: deck,
    currentCard: card,
    activeEffect: battlecry || null,
    pendingDeathrattle: deathrattle || null,
    cardsRevealedCount,
    updatedAt: now,
    updatedBy: "server"
  }, { merge: true });

  await ritualRef.collection("history").add({ type: card.type || "Ritual", text: card.title || "Carta", createdAt: now });

  logInfo("ritual_next_card", { roomId, cardTitle: card.title, cardsRevealedCount, remaining: deck.length });
  return res.json({ ok: true, card, cardsRevealedCount, remaining: deck.length });
}));

// ── POST /game/ritual/reset ───────────────────────────────────────────────────
router.post("/game/ritual/reset", asyncHandler(async (req, res) => {
  const { roomId, hostToken, deckCards } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_reset_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const deckInput = Array.isArray(deckCards) && deckCards.length > 0 ? deckCards : OSL_BASIC_CARDS;
  const deck = cryptoShuffle(deckInput.map(sanitizeCard).filter(Boolean));

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ritualRef = db.collection("salas").doc(roomId).collection("ritual").doc("state");

  await ritualRef.set({
    started: true,
    remainingDeck: deck,
    currentCard: null,
    activeEffect: null,
    pendingDeathrattle: null,
    cardsRevealedCount: 0,
    updatedAt: now,
    updatedBy: "server"
  }, { merge: true });

  await ritualRef.collection("history").add({ type: "Ritual", text: "O ritual foi reiniciado.", createdAt: now });

  logInfo("ritual_reset", { roomId, deckSize: deck.length });
  return res.json({ ok: true, deckSize: deck.length });
}));

module.exports = router;
