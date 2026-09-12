const crypto = require("crypto");
const { logError } = require("./logger");

function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      logError("route_error", error, {
        requestId: req.requestId,
        method: req.method,
        path: safeRequestPath(req)
      });
      next(error);
    }
  };
}

function sendError(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function normalizeUid(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Normaliza email vindo de path param de rota Express
function normalizePathEmail(req) {
  return normalizeEmail(req?.params?.email);
}

function sanitizeNextPath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/")) return "/painel.html";
  if (raw.startsWith("//")) return "/painel.html";
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFirestoreDate(value) {
  try {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    return null;
  } catch {
    return null;
  }
}

function createRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

// Identificador seguro para logs: remove query strings e prefere o molde da
// rota, evitando expor tokens, códigos e identificadores presentes na URL.
function safeRequestPath(req) {
  const routePath = req?.route?.path;
  if (typeof routePath === "string") {
    return `${req.baseUrl || ""}${routePath}` || "/";
  }

  const raw = String(req?.originalUrl || req?.url || "/");
  const queryIndex = raw.search(/[?#]/);
  const pathname = (queryIndex === -1 ? raw : raw.slice(0, queryIndex)) || "/";
  return pathname.split("/").map((segment) => {
    const looksSensitive = segment.length >= 20
      || /@|%40|^[A-Za-z0-9_-]{16,}$|^[A-Fa-f0-9-]{32,}$/.test(segment);
    return looksSensitive ? ":redacted" : segment;
  }).join("/");
}

async function httpFetch(...args) {
  if (typeof fetch === "function") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
}

function nowIso() {
  return new Date().toISOString();
}

function buildDiscordAvatarUrl(discordUser) {
  const userId = String(discordUser?.id || "").trim();
  const avatar  = String(discordUser?.avatar || "").trim();
  if (!userId || !avatar) return "";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}

module.exports = {
  asyncHandler, sendError,
  normalizeUid, normalizeEmail, normalizePathEmail, sanitizeNextPath,
  sleep, formatFirestoreDate,
  createRequestId, safeRequestPath, httpFetch,
  nowIso, buildDiscordAvatarUrl
};
