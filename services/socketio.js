// Singleton do Socket.io — instância compartilhada por todos os routers.
// initSocketIo() chamado uma vez em server.js; getIo() usado nos handlers.
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const { logInfo, logWarn, logError } = require("../logger");

// Rate limit de chat por WebSocket: 20 mensagens/minuto por uid.
// In-memory — adequado para Railway (redeploy reseta, não há estado crítico aqui).
const CHAT_MAX_PER_MIN = 20;
const CHAT_WINDOW_MS   = 60_000;
const chatCounters     = new Map(); // uid → { count, windowStart }

function checkChatRateLimit(uid) {
  const now = Date.now();
  const e   = chatCounters.get(uid);
  if (!e || now - e.windowStart > CHAT_WINDOW_MS) {
    chatCounters.set(uid, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= CHAT_MAX_PER_MIN) return false;
  e.count++;
  return true;
}

let _io = null;

function initSocketIo(httpServer, allowedOrigins) {
  _io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    pingTimeout:  60_000,
    pingInterval: 25_000,
    transports: ["websocket", "polling"]
  });

  // Middleware de autenticação + verificação de ban via Firebase ID Token.
  _io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("AUTH_REQUIRED"));
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      socket.uid = decoded.uid;

      // Usuários banidos não podem conectar ao socket
      const { isUserBanned } = require("./abuseGuard");
      const banned = await isUserBanned(decoded.uid);
      if (banned) {
        logWarn("banned_user_socket_blocked", { uid: decoded.uid });
        return next(new Error("USER_BANNED"));
      }

      next();
    } catch (err) {
      if (err.message === "USER_BANNED") return next(err);
      next(new Error("AUTH_INVALID"));
    }
  });

  _io.on("connection", async (socket) => {
    // Cada usuário entra no próprio room (uid) — push apenas para ele.
    socket.join(socket.uid);
    logInfo("socket_connected", { uid: socket.uid });

    // Notifica amigos que este usuário está online
    _notifyFriendsOnline(socket.uid).catch(() => {});

    // Catch-up: se há rodada ativa para este uid, re-emite round_started com tempo restante
    try {
      const { getRoundCatchupForUser } = require("./encontroService");
      const catchup = await getRoundCatchupForUser(socket.uid);
      if (catchup) {
        if (catchup.type === "round_started") {
          logInfo("socket_catchup_round_started", { uid: socket.uid, round: catchup.round, remaining: catchup.durationMs });
          socket.emit("encontro:round_started", {
            eventId:      catchup.eventId,
            round:        catchup.round,
            totalRounds:  catchup.totalRounds,
            room:         catchup.room,
            livekitToken: catchup.livekitToken,
            partnerName:  catchup.partnerName,
            durationMs:   catchup.durationMs,
          });
        } else if (catchup.type === "sitting_out") {
          socket.emit("encontro:sitting_out", {
            eventId:    catchup.eventId,
            round:      catchup.round,
            totalRounds: catchup.totalRounds,
            durationMs: catchup.durationMs,
          });
        }
      }
    } catch (err) {
      logError("socket_catchup_error", err, { uid: socket.uid });
    }

    socket.on("chat:message", async ({ eventId, recipientUid, text }) => {
      if (!eventId || !recipientUid || !text?.trim()) return;

      // Rate limit: 20 mensagens/min por usuário
      if (!checkChatRateLimit(socket.uid)) {
        logWarn("chat_rate_limit_hit", { uid: socket.uid, eventId });
        socket.emit("chat:error", { error: "MENSAGENS_MUITO_RAPIDAS" });
        return;
      }

      const safeText = String(text).trim().slice(0, 500);
      try {
        const { checkMutualMatch, saveChatMessage, makeChatId } = require("./encontroService");
        const ok = await checkMutualMatch(eventId, socket.uid, recipientUid);
        if (!ok) return;
        const chatId  = makeChatId(eventId, socket.uid, recipientUid);
        const msg     = await saveChatMessage(chatId, socket.uid, safeText);
        const payload = { chatId, senderUid: socket.uid, text: safeText, createdAt: msg.createdAt };
        _io.to(socket.uid).emit("chat:receive", payload);
        _io.to(recipientUid).emit("chat:receive", payload);
      } catch (err) {
        logError("chat_message_error", err, { uid: socket.uid });
      }
    });

    socket.on("disconnect", () => {
      logInfo("socket_disconnected", { uid: socket.uid });
      // Sem notificação de offline imediata — evita noise de reconexões.
      // A presença decai naturalmente via lastSeenAt (TTL 5 min).
    });
  });

  // ── World updates em tempo real ───────────────────────────────────────────

  const events = require("./events");

  // Missão comunitária completada → broadcast para todos os conectados
  events.on("world.mission_completed", async ({ payload }) => {
    try {
      const worldState = require("./worldState");
      const world = await worldState.getWorldState();
      _io.emit("world:update", { world, reason: "mission_completed", ...payload });
      logInfo("socket_world_update_broadcast", { reason: "mission_completed", sockets: _io.sockets.size });
    } catch (err) {
      logError("socket_world_update_error", err);
    }
  });

  // Ritual diário completado → atualiza totalDailyParticipants para todos
  events.on("live.daily_ritual_completed", async ({ payload }) => {
    try {
      const worldState = require("./worldState");
      const world = await worldState.getWorldState();
      if (world) _io.emit("world:update", { world, reason: "daily_ritual_completed" });
    } catch (_) {}
  });

  return _io;
}

/**
 * Emite social:friend_online para as conexões do usuário que acabou de conectar.
 * Lazy: carrega socialGraph via require para evitar circular dep no boot.
 *
 * Apenas top 10 conexões (as mais frequentes) — sem spam.
 */
async function _notifyFriendsOnline(uid) {
  if (!_io) return;
  const socialGraph = require("./socialGraph");
  const connections = await socialGraph.getConnections(uid, 10);
  for (const conn of connections) {
    _io.to(conn.uid).emit("social:friend_online", { uid });
  }
}

/**
 * Emite um evento para um usuário específico (por uid).
 * Usado por outros serviços para push de notificações em tempo real.
 */
function emitToUser(uid, event, data) {
  if (!_io) return;
  _io.to(uid).emit(event, data);
}

function getIo() { return _io; }

module.exports = { initSocketIo, getIo, emitToUser };
