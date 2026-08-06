const express = require("express");
const { logError } = require("../logger");
const { sendError, nowIso } = require("../utils");
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
const { verifySignedToken } = require("../services/auth");
const { ADMIN_SECRET } = require("../config");

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

router.post("/game/room/create", roomLimiter, (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const name   = String(req.body?.name || "").trim();
    const host   = String(req.body?.host || "").trim();

    if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    if (panelRooms.has(roomId)) return res.status(409).json({ ok: false, code: "SALA_JA_EXISTE" });

    const room = getOrCreatePanelRoom(roomId, name, host);
    broadcastPanelUpdate();
    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_room_create_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_CREATE");
  }
});

router.post("/game/player/join", joinLimiter, (req, res) => {
  try {
    const roomId     = normalizeRoomId(req.body?.roomId);
    const playerId   = normalizePlayerId(req.body?.playerId);
    const playerName = normalizePlayerName(req.body?.playerName) || "Jogador";

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    const room = panelRooms.get(roomId);
    if (!room) return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" });

    const isRejoin = !!room.players[playerId];

    if (!isRejoin) {
      if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) {
        return res.status(409).json({ ok: false, code: "SALA_CHEIA" });
      }
      if (isPlayerNameTaken(playerName, playerId)) {
        const suggestion = suggestPlayerName(playerName);
        return res.status(409).json({ ok: false, code: "NOME_JA_EM_USO", suggestion });
      }
    }

    room.players[playerId] = {
      playerId, playerName,
      joinedAt: room.players[playerId]?.joinedAt || nowIso(),
      lastSeen: nowIso()
    };
    room.updatedAt = nowIso();
    pendingJoinRequests.delete(`${roomId}:${playerId}`);

    return res.json({ ok: true, room: serializePanelRoom(room) });
  } catch (error) {
    logError("game_player_join_error", error);
    return sendError(res, 500, "ERRO_GAME_PLAYER_JOIN");
  }
});

router.post("/game/player/leave", (req, res) => {
  try {
    const roomId       = normalizeRoomId(req.body?.roomId);
    const playerId     = normalizePlayerId(req.body?.playerId);
    const isHostLeaving = req.body?.isHost === true;

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

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
});

// SSE dedicado para o anfitrião receber notificações de pedidos de entrada
router.get("/game/room/:roomId/host-sse", (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

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

router.post("/game/room/request-join", (req, res) => {
  try {
    const roomId     = normalizeRoomId(req.body?.roomId);
    const roomName   = String(req.body?.roomName || "").trim();
    const playerId   = normalizePlayerId(req.body?.playerId);
    const playerName = normalizePlayerName(req.body?.playerName) || "Jogador";

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    const room = panelRooms.get(roomId);
    if (!room) return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" });
    if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) return res.status(409).json({ ok: false, code: "SALA_CHEIA" });

    if (roomName.toLowerCase() !== (room.name || "").toLowerCase()) {
      return res.status(403).json({ ok: false, code: "NOME_SALA_INCORRETO" });
    }
    if (isPlayerNameTaken(playerName, playerId)) {
      const suggestion = suggestPlayerName(playerName);
      return res.status(409).json({ ok: false, code: "NOME_JA_EM_USO", suggestion });
    }

    const key = `${roomId}:${playerId}`;
    pendingJoinRequests.set(key, { roomId, playerId, playerName, requestedAt: nowIso() });
    const notified = notifyRoomHost(roomId, "join_request", { roomId, playerId, playerName });

    return res.json({ ok: true, status: "pending", hostOnline: notified });
  } catch (error) {
    logError("game_room_request_join_error", error);
    return sendError(res, 500, "ERRO_GAME_ROOM_REQUEST_JOIN");
  }
});

router.post("/game/room/approve-join", (req, res) => {
  try {
    const roomId   = normalizeRoomId(req.body?.roomId);
    const playerId = normalizePlayerId(req.body?.playerId);

    if (!roomId || !playerId) return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");

    const key     = `${roomId}:${playerId}`;
    const pending = pendingJoinRequests.get(key);
    if (!pending) return res.status(404).json({ ok: false, code: "PEDIDO_NAO_ENCONTRADO" });

    const room = panelRooms.get(roomId);
    if (!room) { pendingJoinRequests.delete(key); return res.status(404).json({ ok: false, code: "SALA_NAO_ENCONTRADA" }); }
    if (getRoomPlayerCount(room) >= MAX_ROOM_PLAYERS) { pendingJoinRequests.delete(key); return res.status(409).json({ ok: false, code: "SALA_CHEIA" }); }

    room.players[playerId] = { playerId, playerName: pending.playerName, joinedAt: nowIso(), lastSeen: nowIso() };
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

router.post("/game/cleanup", (req, res) => {
  try {
    cleanupPanelRooms();
    return res.json({ ok: true, totalRooms: panelRooms.size });
  } catch (error) {
    logError("game_cleanup_error", error);
    return sendError(res, 500, "ERRO_GAME_CLEANUP");
  }
});

module.exports = router;
