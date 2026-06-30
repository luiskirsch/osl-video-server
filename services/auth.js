const crypto = require("crypto");
const admin  = require("firebase-admin");
const { sendError } = require("../utils");
const { ADMIN_SECRET, ACCESS_TOKEN_SECRET, PRODUCT_ID, LICENSE_SECRET } = require("../config");

// --- JWT customizado (base64url + HMAC-SHA256) ---

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = input.length % 4;
  if (pad) input += "=".repeat(4 - pad);
  return Buffer.from(input, "base64").toString("utf8");
}

function signPayload(payload, secret) {
  if (!secret) throw new Error("SECRET_NAO_CONFIGURADO");
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token, secret) {
  if (!secret) return { valid: false, error: "SECRET_NAO_CONFIGURADO" };
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "TOKEN_INVALIDO" };
  }

  const [encodedPayload, signature] = token.split(".");

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // timing-safe compare: evita oracle de length/byte-prefix em endpoints HTTP.
  // String length differ ja invalida (e a propria comparacao por bytes precisa
  // de mesmo size pra timingSafeEqual nao dar throw).
  if (signature.length !== expectedSignature.length) {
    return { valid: false, error: "ASSINATURA_INVALIDA" };
  }
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch { match = false; }
  if (!match) {
    return { valid: false, error: "ASSINATURA_INVALIDA" };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    return { valid: false, error: "PAYLOAD_INVALIDO" };
  }

  if (payload.exp && Date.now() > payload.exp) {
    return { valid: false, error: "TOKEN_EXPIRADO", payload };
  }

  return { valid: true, payload };
}

// --- Helpers de extração de token ---

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

// --- Middlewares ---

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function requireGameAccess(req, res, next) {
  if (ADMIN_SECRET) {
    const adminKey = String(req.headers["x-admin-secret"] || "").trim();
    if (adminKey && timingSafeStringEqual(adminKey, ADMIN_SECRET)) {
      req.gameAccess = { token_type: "game_access", product: PRODUCT_ID, bypass: true };
      return next();
    }
  }

  const accessToken = getBearerToken(req);
  if (!accessToken) return sendError(res, 401, "ACESSO_NAO_INFORMADO");

  const verification = verifySignedToken(accessToken, ACCESS_TOKEN_SECRET);
  if (!verification.valid) {
    return sendError(res, 401, "ACESSO_INVALIDO", { detail: verification.error || null });
  }

  const payload = verification.payload;
  if (payload.token_type !== "game_access" || payload.product !== PRODUCT_ID) {
    return sendError(res, 401, "ACESSO_NEGADO");
  }

  req.gameAccess = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return sendError(res, 503, "ADMIN_NAO_CONFIGURADO");
  // Só header — secret em req.body fica sujeito a ferramentas de observabilidade
  // (Sentry, APM) que costumam capturar o body em erros 4xx/5xx por padrão.
  const provided = String(req.headers["x-admin-secret"] || "").trim();
  if (!provided || !timingSafeStringEqual(provided, ADMIN_SECRET)) return sendError(res, 403, "ADMIN_SECRET_INVALIDO");
  next();
}

async function verifyFirebaseToken(req, res) {
  const bearer = getBearerToken(req);
  if (!bearer) { sendError(res, 401, "TOKEN_NAO_INFORMADO"); return null; }
  try {
    const decoded = await admin.auth().verifyIdToken(bearer);
    return decoded.uid;
  } catch {
    sendError(res, 401, "TOKEN_INVALIDO");
    return null;
  }
}

// --- Geração de código de licença ---

function generateLicenseCode(paymentId, externalReference, email) {
  const raw  = `${paymentId}|${externalReference}|${email}|${PRODUCT_ID}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();
  return `OSL-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}`;
}

function generateExternalReference() {
  return `OSL-${Date.now()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

module.exports = {
  base64urlEncode, base64urlDecode,
  signPayload, verifySignedToken,
  getBearerToken, timingSafeStringEqual,
  requireGameAccess, requireAdmin, verifyFirebaseToken,
  generateLicenseCode, generateExternalReference
};
