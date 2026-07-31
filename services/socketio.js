// Singleton do Socket.io — instância compartilhada por todos os routers.
// initSocketIo() chamado uma vez em server.js; getIo() usado nos handlers.
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const { logInfo, logError } = require("../logger");

let _io = null;

function initSocketIo(httpServer, allowedOrigins) {
  _io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    pingTimeout:  60_000,
    pingInterval: 25_000,
    transports: ["websocket", "polling"]
  });

  // Middleware de autenticação via Firebase ID Token.
  _io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("AUTH_REQUIRED"));
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      socket.uid = decoded.uid;
      next();
    } catch {
      next(new Error("AUTH_INVALID"));
    }
  });

  _io.on("connection", async (socket) => {
    // Cada usuário entra no próprio room (uid) — push apenas para ele.
    socket.join(socket.uid);
    logInfo("socket_connected", { uid: socket.uid });

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
      const safeText = String(text).trim().slice(0, 1000);
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
    });
  });

  return _io;
}

function getIo() { return _io; }

module.exports = { initSocketIo, getIo };
