const express = require("express");
const crypto  = require("crypto");
const admin   = require("firebase-admin");
const { getDb }                         = require("../services/firestore");
const { verifyHostToken }               = require("../services/auth");
const { panelRooms }                    = require("../game/state");

// Retorna o playerName verificado a partir do panelRooms (imune a spoofing do body).
function resolvedPlayerName(roomId, uid, fallback) {
  return panelRooms.get(roomId)?.players?.[uid]?.playerName
    || String(fallback || "Jogador").slice(0, 80);
}
const { OSL_CARD_EFFECTS, OSL_BASIC_CARDS, OSL_PACK_CARDS, OSL_PACK_IDS, levelFromXP } = require("../data/cards");
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

async function buildVerifiedDeck(db, firebaseIdToken, players) {
  // Valida compras e prestige server-side a partir do Firebase ID token
  let verifiedPackIds = new Set();
  let isPrestige = false;

  if (firebaseIdToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
      const uid = decoded.uid;
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const data = userSnap.data();
        isPrestige = levelFromXP(data.xp || 0) >= 50;
        for (const c of (data.compras || [])) {
          if (OSL_PACK_IDS.includes(c.produto)) verifiedPackIds.add(c.produto);
        }
      }
    } catch (_) { /* token inválido — sem pacotes extras */ }
  }

  // Cartas customizadas dos jogadores (carregadas do Firestore — não do cliente)
  const customContributions = [];
  for (const p of players) {
    if (p.userId && p.activeDeckId) {
      try {
        const snap = await db.collection("users").doc(p.userId).collection("decks").doc(p.activeDeckId).get();
        if (snap.exists) {
          const cards = (snap.data().cards || []).map(sanitizeCard).filter(Boolean).slice(0, 50);
          customContributions.push(...cards);
        }
      } catch (_) {}
    }
  }

  if (customContributions.length > 0) {
    const allCards = [...OSL_BASIC_CARDS, ...customContributions];
    const seen = new Set();
    return cryptoShuffle(allCards.filter(c => { if (seen.has(c.title)) return false; seen.add(c.title); return true; }));
  }

  const packCards = [];
  const packsToInclude = isPrestige ? OSL_PACK_IDS : [...verifiedPackIds];
  for (const packId of packsToInclude) {
    if (OSL_PACK_CARDS[packId]) packCards.push(...OSL_PACK_CARDS[packId]);
  }
  return cryptoShuffle([...OSL_BASIC_CARDS, ...packCards]);
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
  const { roomId, hostToken, firebaseIdToken, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_start_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const players = sanitizePlayers(rawPlayers);
  // Deck construído inteiramente pelo servidor: compras e prestige verificados
  // via Firebase Admin SDK — cliente não tem como injetar pacotes não comprados.
  const deck = await buildVerifiedDeck(db, firebaseIdToken || null, players);

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
  const { roomId, hostToken, firebaseIdToken, players: rawPlayers } = req.body || {};
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(hostToken, roomId)) {
    logWarn("ritual_reset_unauthorized", { roomId, ip: req.headers["x-forwarded-for"] || null });
    return res.status(403).json({ ok: false, error: "HOST_TOKEN_INVALIDO" });
  }

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const players = sanitizePlayers(rawPlayers);
  const deck = await buildVerifiedDeck(db, firebaseIdToken || null, players);

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
  // Firebase ID token tem precedência (mais seguro).
  const uid = await uidFromFirebaseToken(firebaseIdToken);
  if (uid) return uid;
  // Fallback: verifica se o participantId está na coleção de players da sala.
  return verifyParticipant(db, roomId, participantId);
}

// ── POST /game/ritual/vote ────────────────────────────────────────────────────
router.post("/game/ritual/vote", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, option } = req.body || {};
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

  return res.json({ ok: true });
}));

// ── POST /game/ritual/react ───────────────────────────────────────────────────
router.post("/game/ritual/react", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, emoji, playerName } = req.body || {};
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

  return res.json({ ok: true, ts });
}));

// ── POST /game/ritual/ai-detect ───────────────────────────────────────────────
router.post("/game/ritual/ai-detect", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, source, playerName, message } = req.body || {};
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

  return res.json({ ok: true });
}));

// ── POST /game/ritual/social-pressure ────────────────────────────────────────
router.post("/game/ritual/social-pressure", asyncHandler(async (req, res) => {
  const { roomId, participantId, firebaseIdToken, playerName } = req.body || {};
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

  return res.json({ ok: true });
}));

// ── POST /game/ritual/resolve-effect (host only) ──────────────────────────────
router.post("/game/ritual/resolve-effect", asyncHandler(async (req, res) => {
  const { roomId, hostToken, winner, dismissOnly } = req.body || {};
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
  } else {
    // resolveActiveEffect: limpa efeito ativo + AI detection + registra voto vencedor
    const update = { activeEffect: null, aiDetection: null };
    if (winner) update.voteResult = { winner: String(winner).slice(0, 200), resolvedAt: Date.now() };
    await ritualRef.set(update, { merge: true });
  }

  logInfo("ritual_resolve_effect", { roomId, winner: winner || null, dismissOnly: !!dismissOnly });
  return res.json({ ok: true });
}));

module.exports = router;
