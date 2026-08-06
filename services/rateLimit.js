// Rate limiting usando express-rate-limit (já em deps).
// Todos os limiters são in-memory — reset no redeploy do Railway (aceitável).
// Limiter por uid: requer que requireFirebaseToken rode antes na cadeia.

const rateLimit = require("express-rate-limit");
const { logWarn } = require("../logger");

// Railway appende o IP real do cliente como o último valor no XFF.
// O cliente só pode injetar valores à ESQUERDA (início), nunca à direita.
// Usar o valor mais à direita é sempre o IP real — imune a XFF spoofing.
function getRealIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",").pop().trim() || req.socket?.remoteAddress || "unknown";
  return req.socket?.remoteAddress || "unknown";
}

function makeHandler(errorCode) {
  return (req, res) => {
    logWarn("rate_limit_hit", {
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      path: req.originalUrl,
      uid: req.firebaseUid || null,
      errorCode,
    });
    return res.status(429).json({ ok: false, error: errorCode });
  };
}

// Global: 300 req/min por IP — proteção base contra flood
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  keyGenerator: getRealIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("RATE_LIMIT_EXCEDIDO"),
});

// Check-in: 20 por 5min por IP — freia bots de cadastro
const authLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 20,
  keyGenerator: getRealIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("MUITAS_TENTATIVAS"),
});

// Votos (match): 120 por hora por uid — impede vote farming
const voteLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 120,
  keyGenerator: (req) => req.firebaseUid || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("VOTOS_EXCEDIDOS"),
});

// Upload de foto: 10 por minuto por uid
const photoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) => req.firebaseUid || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("RATE_LIMIT_EXCEDIDO"),
});

// Denúncia: 10 por hora por uid — evita spam de denúncias falsas
const reportLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  keyGenerator: (req) => req.firebaseUid || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("DENUNCIAS_EXCEDIDAS"),
});

// Criação de sala: 20 por hora por IP
const roomLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  keyGenerator: getRealIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("RATE_LIMIT_EXCEDIDO"),
});

// Login do painel: 5 tentativas por 15min por IP — anti brute-force
const panelLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  keyGenerator: getRealIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("MUITAS_TENTATIVAS_DE_LOGIN"),
});

// Join de jogador: 60 por minuto por IP — freia bots de flooding de sala
const joinLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: getRealIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("RATE_LIMIT_EXCEDIDO"),
});

// Criação de sessão terapêutica: 30 por hora por uid — impede criação em massa
const sessaoCriarLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 30,
  keyGenerator: (req) => req.firebaseUid || getRealIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("SESSOES_LIMITE_EXCEDIDO"),
});

module.exports = { globalLimiter, authLimiter, voteLimiter, photoLimiter, reportLimiter, roomLimiter, panelLoginLimiter, joinLimiter, sessaoCriarLimiter };
