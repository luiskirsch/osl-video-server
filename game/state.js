const { logError } = require("../logger");
const { nowIso } = require("../utils");

// --- Constantes de TTL e limites ---
const PANEL_ROOM_TTL_MS   = 1000 * 60 * 60 * 6; // 6h sem jogadores → remove
const PANEL_PLAYER_TTL_MS = 1000 * 60 * 2;       // 2min sem heartbeat → remove jogador
const INACTIVITY_CLOSE_MS = 1000 * 60 * 60;      // 1h sem heartbeat → fecha sala
const MAX_ROOM_PLAYERS    = 5;

// --- Maps de estado em memória ---

// roomId → { roomId, name, host, players, sessionActive, videoActive, recordingActive, ... }
const panelRooms = new Map();

// Clientes SSE do painel admin
const panelClients = new Set();

// roomId → SSE res do anfitrião
const roomHostSseClients = new Map();

// `${roomId}:${playerId}` → { roomId, playerId, playerName, requestedAt }
const pendingJoinRequests = new Map();

// roomId → { egressId, type, ref, email, startedAt, filepath }
const activeRecordings = new Map();

// roomId → { ...job, downloadUrl, completedAt }
const completedRecordings = new Map();

// ref → { approved, paymentId, status, ref, produto, email, roomId, updatedAt }
const pagamentosAprovados = new Map();

// --- Serialização e limpeza de jogadores ---

function cleanupPanelRoomPlayers(room) {
  if (!room?.players) return;
  const now = Date.now();
  for (const [playerId, player] of Object.entries(room.players)) {
    const lastSeenTime = new Date(player.lastSeen || player.updatedAt || room.updatedAt).getTime();
    if (!lastSeenTime || now - lastSeenTime > PANEL_PLAYER_TTL_MS) {
      delete room.players[playerId];
    }
  }
}

function serializePanelRoom(room) {
  cleanupPanelRoomPlayers(room);

  const players = Object.values(room.players || {}).sort((a, b) => {
    const t1 = new Date(a.joinedAt || a.updatedAt || 0).getTime();
    const t2 = new Date(b.joinedAt || b.updatedAt || 0).getTime();
    return t1 - t2;
  });

  return {
    roomId: room.roomId,
    name: room.name || "",
    host: room.host || "",
    createdAt: room.createdAt || null,
    updatedAt: room.updatedAt || null,
    sessionActive: !!room.sessionActive,
    videoActive: !!room.videoActive,
    recordingActive: !!room.recordingActive,
    playerCount: players.length,
    players
  };
}

// --- SSE broadcast ---

function broadcastPanelUpdate() {
  try {
    const rooms = Array.from(panelRooms.values()).map(serializePanelRoom);
    const payload = JSON.stringify({ ok: true, rooms });
    for (const client of panelClients) {
      client.write(`event: rooms\n`);
      client.write(`data: ${payload}\n\n`);
    }
  } catch (e) {
    logError("broadcast_panel_error", e);
  }
}

function notifyRoomHost(roomId, event, data) {
  const hostSse = roomHostSseClients.get(roomId);
  if (!hostSse) return false;
  try {
    hostSse.write(`event: ${event}\n`);
    hostSse.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    roomHostSseClients.delete(roomId);
    return false;
  }
}

module.exports = {
  PANEL_ROOM_TTL_MS, PANEL_PLAYER_TTL_MS, INACTIVITY_CLOSE_MS, MAX_ROOM_PLAYERS,
  panelRooms, panelClients, roomHostSseClients, pendingJoinRequests,
  activeRecordings, completedRecordings, pagamentosAprovados,
  cleanupPanelRoomPlayers, serializePanelRoom,
  broadcastPanelUpdate, notifyRoomHost
};
