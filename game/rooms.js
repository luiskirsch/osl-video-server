const admin = require("firebase-admin");
const { logInfo, logWarn, logError } = require("../logger");
const { nowIso } = require("../utils");
const {
  panelRooms, pendingJoinRequests, roomHostSseClients,
  activeRecordings,
  PANEL_ROOM_TTL_MS, PANEL_PLAYER_TTL_MS, INACTIVITY_CLOSE_MS, MAX_ROOM_PLAYERS,
  broadcastPanelUpdate, cleanupPanelRoomPlayers, serializePanelRoom
} = require("./state");

// --- Normalizações ---

function normalizeRoomId(value)   { return String(value || "").trim(); }
function normalizePlayerId(value) { return String(value || "").trim(); }
function normalizePlayerName(value) { return String(value || "").trim().slice(0, 80); }

// --- Lógica de jogadores ---

// roomId obrigatório: unicidade de nome é por sala, não global.
// Antes era global → DoS: registrar nomes-alvo em qualquer sala bloqueava outros jogadores.
function isPlayerNameTaken(name, excludePlayerId = null, roomId = null) {
  const lower = name.toLowerCase();
  const rooms = roomId
    ? (panelRooms.has(roomId) ? [panelRooms.get(roomId)] : [])
    : Array.from(panelRooms.values());
  for (const room of rooms) {
    for (const player of Object.values(room.players)) {
      if (player.playerName.toLowerCase() === lower && player.playerId !== excludePlayerId) {
        return true;
      }
    }
  }
  return false;
}

function suggestPlayerName(name, roomId = null) {
  let i = 2;
  while (isPlayerNameTaken(`${name}${i}`, null, roomId)) i++;
  return `${name}${i}`;
}

function getRoomPlayerCount(room) {
  cleanupPanelRoomPlayers(room);
  return Object.keys(room.players || {}).length;
}

// --- Criação/recuperação de sala ---

function getOrCreatePanelRoom(roomId, roomName = "", host = "") {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) return null;

  let room = panelRooms.get(normalizedRoomId);

  if (!room) {
    room = {
      roomId: normalizedRoomId,
      name: String(roomName || "").trim(),
      host: String(host || "").trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
      sessionActive: false,
      videoActive: false,
      recordingActive: false,
      players: {}
    };
    panelRooms.set(normalizedRoomId, room);
  }

  if (roomName && !room.name) room.name = String(roomName).trim();
  if (host && !room.host)     room.host = String(host).trim();

  room.updatedAt = nowIso();
  return room;
}

// --- Limpeza periódica ---

function cleanupPanelRooms() {
  const now = Date.now();

  for (const [roomId, room] of panelRooms.entries()) {
    cleanupPanelRoomPlayers(room);

    const lastActivity = new Date(room.lastActivityAt || room.updatedAt || room.createdAt).getTime();
    const lastUpdated  = new Date(room.updatedAt || room.createdAt).getTime();
    const playerCount  = Object.keys(room.players || {}).length;

    if (lastActivity && now - lastActivity > INACTIVITY_CLOSE_MS) {
      closeRoom(roomId, "inactivity");
      continue;
    }

    if (
      (!lastUpdated || now - lastUpdated > PANEL_ROOM_TTL_MS) &&
      playerCount === 0 &&
      !room.sessionActive &&
      !room.videoActive &&
      !room.recordingActive
    ) {
      panelRooms.delete(roomId);
      broadcastPanelUpdate();
    }
  }
}

// --- Fechamento de sala ---

async function closeRoom(roomId, reason = "manual") {
  // Remove do mapa antes das ops async para evitar double-close
  const wasTracked = panelRooms.has(roomId);
  if (wasTracked) {
    panelRooms.delete(roomId);
    broadcastPanelUpdate();
  }

  logInfo("room_closing", { roomId, reason, wasTracked });

  // Para gravação ativa se houver
  if (activeRecordings.has(roomId)) {
    try {
      // Import lazy para evitar dependência circular em tempo de carregamento
      const { stopRoomRecording } = require("../video/webrtc");
      await stopRoomRecording(roomId);
    } catch (err) {
      logError("close_room_stop_recording_error", err, { roomId });
    }
  }

  // Atualiza Firestore (mesmo que a sala não estivesse em memória)
  try {
    const { getDb } = require("../services/firestore");
    const db = getDb();
    if (db) {
      await db.collection("salas").doc(roomId).update({
        status: "closed",
        arenaActive: false,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    logWarn("close_room_firestore_skip", { roomId, detail: err.message });
  }

  // Limpa pedidos pendentes e SSE do anfitrião
  for (const key of pendingJoinRequests.keys()) {
    if (key.startsWith(`${roomId}:`)) pendingJoinRequests.delete(key);
  }
  roomHostSseClients.delete(roomId);

  logInfo("room_closed", { roomId, reason });
}

// Inicia limpeza periódica a cada 30 segundos
setInterval(cleanupPanelRooms, 30 * 1000).unref();

module.exports = {
  normalizeRoomId, normalizePlayerId, normalizePlayerName,
  isPlayerNameTaken, suggestPlayerName, getRoomPlayerCount,
  getOrCreatePanelRoom, cleanupPanelRooms, closeRoom
};
