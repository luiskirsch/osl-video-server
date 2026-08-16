const express = require("express");
const { logError, logInfo, logWarn } = require("../logger");
const { asyncHandler, sendError, nowIso } = require("../utils");
const {
  panelRooms, panelClients, roomHostSseClients, pendingJoinRequests,
  serializePanelRoom, broadcastPanelUpdate, notifyRoomHost
} = require("../game/state");
const {
  normalizeRoomId, normalizePlayerId, normalizePlayerName,
  isPlayerNameTaken, suggestPlayerName, getRoomPlayerCount,
  getOrCreatePanelRoom, cleanupPanelRooms, closeRoom
} = require("../game/rooms");
const { MAX_ROOM_PLAYERS } = require("../game/state");
const { roomLimiter, joinLimiter } = require("../services/rateLimit");
const { verifySignedToken, signHostToken, requireAdmin, getBearerToken } = require("../services/auth");
const { ADMIN_SECRET, ACCESS_TOKEN_SECRET } = require("../config");
const { getDb } = require("../services/firestore");
const admin = require("firebase-admin");

const router = express.Router();

// Verifica token de sessão do painel via Authorization header OU ?token query param
// (EventSource do browser não suporta headers customizados, logo aceita query param).
function checkPanelToken(req) {
  const fromQuery  = req.query.token || "";
  const fromHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const token = fromQuery || fromHeader;
  if (!token || !ADMIN_SECRET) return false;
  const r = verifySignedToken(token, ADMIN_SECRET);
  return r.valid && r.payload?.token_type === "panel_session";
}

// Verifica hostToken para uma sala específica.
// Aceita o token no body (hostToken) ou no header x-host-token.
function verifyHostToken(req, roomId) {
  const token = String(
    req.body?.hostToken ||
    req.headers["x-host-token"] ||
    req.query?.hostToken ||
    ""
  ).trim();
  if (!token || !ACCESS_TOKEN_SECRET) return false;
  const r = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  return r.valid && r.payload?.token_type === "host" && r.payload?.roomId === normalizeRoomId(roomId);
}

// Vincula a participação à conta sem confiar em userId vindo do cliente.
// Convidados/fluxos legados continuam permitidos sem token, mas ficam sem UID
// canônico e, portanto, sem progressão de conta.
async function verifyPlayerIdentity(firebaseIdToken, playerId) {
  const token = String(firebaseIdToken || "").trim();
  if (!token) return { userId: null, error: null };

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== playerId) {
      return { userId: null, error: "PLAYER_ID_NAO_CORRESPONDE_A_CONTA" };
    }
    return { userId: decoded.uid, error: null };
  } catch (_) {
    return { userId: null, error: "FIREBASE_TOKEN_INVALIDO" };
  }
}

const LEGACY_PROFILE_MIGRATION_FIELDS = [
  "displayName", "name", "username", "bio", "avatar", "avatarEmoji",
  "avatarColor", "avatarPhotoUrl", "photoURL", "xp", "coins",
  "achievements", "stats", "friends", "incomingRequests", "outgoingRequests",
  "reputation", "dailyStreak", "lastDailyCompletedDate", "lastLoginRewardDate",
  "loginRewardStreak", "pendingLoginXp", "bgTheme", "cardStyle",
  "visualEffect", "memberSince", "activeDeckId",
];

function pickLegacyProfileFields(data = {}) {
  const picked = {};
  for (const key of LEGACY_PROFILE_MIGRATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) picked[key] = data[key];
  }
  return picked;
}

// --- SSE do painel ---

router.get("/panel/stream", (req, res) => {
  if (!checkPanelToken(req)) {
    res.status(403).json({ ok: false, error: "ADMIN_SECRET_INVALIDO" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  panelClients.add(res);

  try {
    const rooms = Array.from(panelRooms.values()).map(serializePanelRoom);
    res.write(`event: rooms\n`);
    res.write(`data: ${JSON.stringify({ ok: true, rooms })}\n\n`);
  } catch {}

  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    panelClients.delete(res);
  });
});

// --- Salas ---

router.post("/game/room/create", roomLimiter, asyncHandler(async (req, res) => {
    const roomId = normalizeRoomId(req.body?.roomId);
    const name   = String(req.body?.name || "").trim();
    const host   = String(req.body?.host || "").trim();
    const firebaseIdToken = String(req.body?.firebaseIdToken || "").trim();

    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (!firebaseIdToken) return sendError(res, 401, "FIREBASE_TOKEN_OBRIGATORIO");

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(firebaseIdToken);
    } catch (_) {
      return sendError(res, 401, "FIREBASE_TOKEN_INVALIDO");
    }

    const db = getDb();
    if (!db) return sendError(res, 503, "DB_INDISPONIVEL");
    const roomSnap = await db.collection("salas").doc(roomId).get();
    if (!roomSnap.exists) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    if (String(roomSnap.data()?.hostId || "") !== decoded.uid) {
      return sendError(res, 403, "USUARIO_NAO_E_ANFITRIAO");
    }
    if (panelRooms.has(roomId)) return res.status(409).json({ ok: false, code: "SALA_JA_EXISTE" });

    const room = getOrCreatePanelRoom(roomId, name, host);
    broadcastPanelUpdate();

    let hostToken = null;
    try { hostToken = signHostToken(roomId); } catch (_) { /* ACCESS_TOKEN_SECRET não configurado */ }

    return res.json({ ok: true, room: serializePanelRoom(room), hostToken });
}));

// Recupera um hostToken para o anfitriao autenticado da sala.
// O token do Firebase prova a identidade; o Firestore continua sendo a fonte
// de verdade para a propriedade da sala. Nenhum dado da sala e devolvido.
router.post("/game/room/host-token", roomLimiter, asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  const firebaseIdToken = String(req.body?.firebaseIdToken || "").trim();

  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!firebaseIdToken) return sendError(res, 400, "FIREBASE_TOKEN_OBRIGATORIO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(firebaseIdToken);
  } catch (_) {
    return sendError(res, 401, "FIREBASE_TOKEN_INVALIDO");
  }

  const roomSnap = await db.collection("salas").doc(roomId).get();
  if (!roomSnap.exists) return sendError(res, 404, "SALA_NAO_ENCONTRADA");

  const hostId = String(roomSnap.data()?.hostId || "").trim();
  if (!hostId || decoded.uid !== hostId) {
    return sendError(res, 403, "USUARIO_NAO_E_ANFITRIAO");
  }

  let hostToken;
  try {
    hostToken = signHostToken(roomId);
  } catch (error) {
    logError("game_room_host_token_sign_error", error, { roomId });
    return sendError(res, 503, "HOST_TOKEN_INDISPONIVEL");
  }

  logInfo("game_room_host_token_issued", { roomId, uid: decoded.uid });
  return res.json({ ok: true, hostToken });
}));

router.post("/game/player/join", joinLimiter, asyncHandler(async (req, res) => {
    const roomId     = normalizeRoomId(req.body?.roomId);
    const playerId   = normalizePlayerId(req.body?.playerId);
    const playerName = normalizePlayerName(req.body?.playerName) || "Jogador";

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    const room = panelRooms.get(roomId);
    if (!room) return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" });

    const identity = await verifyPlayerIdentity(req.body?.firebaseIdToken, playerId);
    if (identity.error) return sendError(res, 403, identity.error);

    const isRejoin = !!room.players[playerId];

    // Novos jogadores só podem entrar via approve-join (que já os adiciona a room.players)
    // OU se trouxerem o hostToken (caso do próprio host entrando na sala que criou).
    if (!isRejoin && !verifyHostToken(req, roomId)) {
      return res.status(403).json({ ok: false, code: "APROVACAO_NECESSARIA" });
    }

    if (!isRejoin) {
      if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) {
        return res.status(409).json({ ok: false, code: "SALA_CHEIA" });
      }
      if (isPlayerNameTaken(playerName, playerId, roomId)) {
        const suggestion = suggestPlayerName(playerName, roomId);
        return res.status(409).json({ ok: false, code: "NOME_JA_EM_USO", suggestion });
      }
    }

    room.players[playerId] = {
      playerId, playerName,
      userId: identity.userId || room.players[playerId]?.userId || null,
      joinedAt: room.players[playerId]?.joinedAt || nowIso(),
      lastSeen: nowIso()
    };
    room.updatedAt = nowIso();
    pendingJoinRequests.delete(`${roomId}:${playerId}`);

    return res.json({ ok: true, room: serializePanelRoom(room) });
}));

router.post("/game/player/leave", asyncHandler(async (req, res) => {
  try {
    const roomId       = normalizeRoomId(req.body?.roomId);
    const playerId     = normalizePlayerId(req.body?.playerId);
    // isHost verificado via hostToken — nunca confiado do body (VULN-02 fix)
    const isHostLeaving = verifyHostToken(req, roomId);

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    // O host usa a capability da sala. Qualquer outro participante precisa
    // provar que o playerId removido pertence ao seu Firebase ID token.
    if (!isHostLeaving) {
      const identity = await verifyPlayerIdentity(req.body?.firebaseIdToken, playerId);
      if (identity.error || !identity.userId) {
        return sendError(res, 403, identity.error || "PARTICIPANTE_NAO_AUTORIZADO");
      }
    }

    const room = panelRooms.get(roomId);
    if (!room) {
      if (isHostLeaving) closeRoom(roomId, "host_left_untracked");
      return res.json({ ok: true, room: null });
    }

    delete room.players[playerId];
    room.updatedAt = nowIso();

    const remaining = Object.keys(room.players || {}).length;
    if (remaining === 0 || isHostLeaving) {
      closeRoom(roomId, isHostLeaving ? "host_left" : "empty");
      return res.json({ ok: true, room: null });
    }

    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_player_leave_error", error);
    return sendError(res, 500, "ERRO_GAME_PLAYER_LEAVE");
  }
}));

// SSE dedicado para o anfitrião receber notificações de pedidos de entrada
router.get("/game/room/:roomId/host-sse", (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostToken(req, roomId)) {
    return sendError(res, 403, "HOST_TOKEN_INVALIDO");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  roomHostSseClients.set(roomId, res);
  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (roomHostSseClients.get(roomId) === res) roomHostSseClients.delete(roomId);
  });
});

router.post("/game/room/request-join", asyncHandler(async (req, res) => {
    const roomId     = normalizeRoomId(req.body?.roomId);
    const roomName   = String(req.body?.roomName || "").trim();
    const playerId   = normalizePlayerId(req.body?.playerId);
    const playerName = normalizePlayerName(req.body?.playerName) || "Jogador";

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    const identity = await verifyPlayerIdentity(req.body?.firebaseIdToken, playerId);
    if (identity.error) return sendError(res, 403, identity.error);

    const room = panelRooms.get(roomId);
    if (!room) return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" });
    if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) return res.status(409).json({ ok: false, code: "SALA_CHEIA" });

    if (roomName.toLowerCase() !== (room.name || "").toLowerCase()) {
      return res.status(403).json({ ok: false, code: "NOME_SALA_INCORRETO" });
    }
    if (isPlayerNameTaken(playerName, playerId, roomId)) {
      const suggestion = suggestPlayerName(playerName, roomId);
      return res.status(409).json({ ok: false, code: "NOME_JA_EM_USO", suggestion });
    }

    const key = `${roomId}:${playerId}`;
    pendingJoinRequests.set(key, {
      roomId,
      playerId,
      playerName,
      userId: identity.userId,
      requestedAt: nowIso(),
    });
    const notified = notifyRoomHost(roomId, "join_request", { roomId, playerId, playerName });

    return res.json({ ok: true, status: "pending", hostOnline: notified });
}));

// Status publico e minimo para o solicitante acompanhar o pedido de entrada.
// Nao expoe nome da sala, jogadores ou qualquer outro estado interno.
router.get("/game/room/:roomId/join-status", joinLimiter, (req, res) => {
  try {
    const roomId   = normalizeRoomId(req.params.roomId);
    const playerId = normalizePlayerId(req.query.playerId);

    if (!roomId || !playerId) {
      return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");
    }

    const room = panelRooms.get(roomId);
    const key  = `${roomId}:${playerId}`;
    let status = "denied";

    if (room?.players?.[playerId]) status = "approved";
    else if (pendingJoinRequests.has(key)) status = "pending";

    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, status });
  } catch (error) {
    logError("game_room_join_status_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_JOIN_STATUS");
  }
});

router.post("/game/room/approve-join", (req, res) => {
  try {
    const roomId   = normalizeRoomId(req.body?.roomId);
    const playerId = normalizePlayerId(req.body?.playerId);

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");

    const key     = `${roomId}:${playerId}`;
    const pending = pendingJoinRequests.get(key);
    if (!pending) return res.status(404).json({ ok: false, code: "PEDIDO_NAO_ENCONTRADO" });

    const room = panelRooms.get(roomId);
    if (!room) { pendingJoinRequests.delete(key); return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" }); }
    if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) { pendingJoinRequests.delete(key); return res.status(409).json({ ok: false, code: "SALA_CHEIA" }); }

    room.players[playerId] = {
      playerId,
      playerName: pending.playerName,
      userId: pending.userId || null,
      joinedAt: nowIso(),
      lastSeen: nowIso(),
    };
    room.updatedAt = nowIso();
    pendingJoinRequests.delete(key);
    broadcastPanelUpdate();

    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_room_approve_join_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_APPROVE_JOIN");
  }
});

router.post("/game/room/deny-join", (req, res) => {
  try {
    const roomId   = normalizeRoomId(req.body?.roomId);
    const playerId = normalizePlayerId(req.body?.playerId);
    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
    const existed = pendingJoinRequests.delete(`${roomId}:${playerId}`);
    return res.json({ ok: true, removed: existed });
  } catch (error) {
    logError("game_room_deny_join_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_DENY_JOIN");
  }
});

router.post("/game/room/heartbeat", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    const room = panelRooms.get(roomId);
    if (!room) return res.json({ ok: true });
    room.lastActivityAt = nowIso();
    room.updatedAt      = nowIso();
    return res.json({ ok: true });
  } catch (error) {
    logError("game_room_heartbeat_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_HEARTBEAT");
  }
});

router.post("/game/session/start", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
    if (!panelRooms.has(roomId)) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    const room = getOrCreatePanelRoom(roomId);
    room.sessionActive = true;
    room.updatedAt = nowIso();
    broadcastPanelUpdate();
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_session_start_error", error);
    return sendError(res, 500, "ERRO_GAME_SESSION_START");
  }
});

router.post("/game/session/end", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
    if (!panelRooms.has(roomId)) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    const room = getOrCreatePanelRoom(roomId);
    room.sessionActive  = false;
    room.videoActive    = false;
    room.recordingActive = false;
    room.updatedAt = nowIso();
    broadcastPanelUpdate();
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_session_end_error", error);
    return sendError(res, 500, "ERRO_GAME_SESSION_END");
  }
});

router.post("/game/video", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const active = !!req.body?.active;
    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
    if (!panelRooms.has(roomId)) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    const room = getOrCreatePanelRoom(roomId);
    room.videoActive = active;
    room.updatedAt   = nowIso();
    broadcastPanelUpdate();
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_video_error", error);
    return sendError(res, 500, "ERRO_GAME_VIDEO");
  }
});

router.post("/game/recording", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const active = !!req.body?.active;
    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (!verifyHostToken(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
    if (!panelRooms.has(roomId)) return sendError(res, 404, "SALA_NAO_ENCONTRADA");
    const room = getOrCreatePanelRoom(roomId);
    room.recordingActive = active;
    room.updatedAt       = nowIso();
    broadcastPanelUpdate();
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_recording_error", error);
    return sendError(res, 500, "ERRO_GAME_RECORDING");
  }
});

router.get("/game/room/:roomId", (req, res) => {
  if (!checkPanelToken(req)) return sendError(res, 403, "ADMIN_SECRET_INVALIDO");
  try {
    const roomId = normalizeRoomId(req.params.roomId);
    const room   = panelRooms.get(roomId);
    if (!room) return sendError(res, 404, "ROOM_NAO_ENCONTRADA");
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_room_get_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_GET");
  }
});

router.get("/game/rooms", (req, res) => {
  try {
    cleanupPanelRooms();
    const rooms = Array.from(panelRooms.values())
      .map(serializePanelRoom)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
    return res.json({ ok: true, rooms });
  } catch (error) {
    logError("game_rooms_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOMS");
  }
});

router.post("/game/cleanup", requireAdmin, (req, res) => {
  try {
    cleanupPanelRooms();
    return res.json({ ok: true, totalRooms: panelRooms.size });
  } catch (error) {
    logError("game_cleanup_error", error);
    return sendError(res, 500, "ERRO_GAME_CLEANUP");
  }
});

// Migra perfil do usuário do UID antigo (osl_user_id) para Firebase UID.
// Chamado uma vez por ensureUserProfile() quando o doc novo não existe mas o antigo sim.
router.post("/game/migrar-perfil", asyncHandler(async (req, res) => {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, "FIREBASE_TOKEN_OBRIGATORIO");

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (_) {
    return sendError(res, 401, "FIREBASE_TOKEN_INVALIDO");
  }

  const newUid = decoded.uid;
  const { oldUserId } = req.body;

  // Valida formato do oldUserId: deve ser "u_" + 10-20 chars alfanuméricos
  if (!oldUserId || typeof oldUserId !== "string" || !/^u_[a-z0-9]{5,30}$/.test(oldUserId)) {
    return sendError(res, 400, "INVALID_OLD_USER_ID");
  }
  if (oldUserId === newUid) return res.json({ ok: true, skipped: "same_uid" });

  const db = getDb();
  if (!db) return sendError(res, 503, "FIRESTORE_UNAVAILABLE");

  const oldRef = db.collection("users").doc(oldUserId);
  const newRef = db.collection("users").doc(newUid);

  const oldSnap = await oldRef.get();

  if (!oldSnap.exists) return res.json({ ok: true, skipped: "old_not_found" });

  const oldData = oldSnap.data() || {};
  if (oldData.migratedTo === newUid) {
    return res.json({ ok: true, skipped: "already_migrated" });
  }
  const verifiedEmail = decoded.email_verified === true
    ? String(decoded.email || "").trim().toLowerCase()
    : "";
  const legacyEmail = String(oldData.email || "").trim().toLowerCase();
  const explicitlyClaimed = String(oldData.migrationClaimUid || "") === newUid;
  const emailProvesOwnership = Boolean(verifiedEmail && legacyEmail && verifiedEmail === legacyEmail);
  if (!explicitlyClaimed && !emailProvesOwnership) {
    logWarn("profile_migration_rejected", { oldUserId, newUid, reason: "proof_required" });
    return sendError(res, 403, "MIGRATION_PROOF_REQUIRED");
  }
  if (oldData.migratedTo && oldData.migratedTo !== newUid) {
    return sendError(res, 409, "LEGACY_PROFILE_ALREADY_CLAIMED");
  }

  let outcome;
  try {
    outcome = await db.runTransaction(async tx => {
    const [freshOld, freshNew] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);
    if (!freshOld.exists) return { skipped: "old_not_found" };
    const freshData = freshOld.data() || {};
    if (freshData.migratedTo === newUid) {
      return { skipped: "already_migrated" };
    }
    if (freshData.migratedTo && freshData.migratedTo !== newUid) {
      throw Object.assign(new Error("LEGACY_PROFILE_ALREADY_CLAIMED"), { code: "already-claimed" });
    }
    const freshLegacyEmail = String(freshData.email || "").trim().toLowerCase();
    const freshProof = String(freshData.migrationClaimUid || "") === newUid
      || Boolean(verifiedEmail && freshLegacyEmail && verifiedEmail === freshLegacyEmail);
    if (!freshProof) {
      throw Object.assign(new Error("MIGRATION_PROOF_REQUIRED"), { code: "proof-required" });
    }

    const newData = freshNew.exists ? (freshNew.data() || {}) : {};
    if ((Number(newData.xp) || 0) > 0
      || (Number(newData.coins) || 0) > 0
      || Object.keys(newData.achievements || {}).length > 0) {
      return { skipped: "new_has_data" };
    }

    tx.set(newRef, {
      ...pickLegacyProfileFields(freshData),
      schemaVersion: 1,
      uid: newUid,
      userId: newUid,
      email: decoded.email || freshData.email || null,
      migratedFrom: oldUserId,
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(oldRef, {
      migratedTo: newUid,
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
      return { migrated: true };
    });
  } catch (error) {
    if (error?.code === "already-claimed") {
      return sendError(res, 409, "LEGACY_PROFILE_ALREADY_CLAIMED");
    }
    if (error?.code === "proof-required") {
      return sendError(res, 403, "MIGRATION_PROOF_REQUIRED");
    }
    throw error;
  }

  if (outcome?.skipped) return res.json({ ok: true, skipped: outcome.skipped });
  logInfo("profile_migrated", { oldUserId, newUid });

  return res.json({ ok: true, migrated: true });
}));

// ── POST /game/redeem-pending-coins ──────────────────────────────────────────
// Aplica moedas pendentes (compra MP sem perfil ativo) ao usuário autenticado.
// Idempotente: pending_coins/{email} é deletado na transação.
router.post("/game/redeem-pending-coins", asyncHandler(async (req, res) => {
  const { firebaseIdToken } = req.body || {};
  if (!firebaseIdToken) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
    uid   = decoded.uid;
    email = decoded.email || null;
  } catch (_) {
    return sendError(res, 403, "TOKEN_INVALIDO");
  }

  if (!email) return res.json({ ok: true, coinsAdded: 0 });

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const pendingRef = db.collection("pending_coins").doc(email);
  const userRef    = db.collection("users").doc(uid);

  try {
    let coinsAdded = 0;
    await db.runTransaction(async (tx) => {
      const pendingSnap = await tx.get(pendingRef);
      if (!pendingSnap.exists) return;
      const coins = pendingSnap.data().coins || 0;
      if (coins <= 0) { tx.delete(pendingRef); return; }
      coinsAdded = coins;
      tx.update(userRef, { coins: admin.firestore.FieldValue.increment(coinsAdded) });
      tx.delete(pendingRef);
    });
    if (coinsAdded > 0) logInfo("pending_coins_redeemed", { uid, email, coinsAdded });
    return res.json({ ok: true, coinsAdded });
  } catch (e) {
    logError("redeem_pending_coins_error", { uid, email, error: e.message });
    return res.json({ ok: true, coinsAdded: 0 });
  }
}));

module.exports = router;
