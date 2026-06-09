// Singleton do Socket.io — instância compartilhada por todos os routers.
// initSocketIo() chamado uma vez em server.js; getIo() usado nos handlers.
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const { logInfo } = require("../logger");

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

  _io.on("connection", (socket) => {
    // Cada profissional entra no próprio room (uid) — push apenas para ele.
    socket.join(socket.uid);
    logInfo("socket_connected", { uid: socket.uid });
    socket.on("disconnect", () => {
      logInfo("socket_disconnected", { uid: socket.uid });
    });
  });

  return _io;
}

function getIo() { return _io; }

module.exports = { initSocketIo, getIo };
