process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  logError(
    "unhandledRejection",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");
const admin = require("firebase-admin");
const helmet = require("helmet");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

const APP_START_TIME = Date.now();
const LOG_FILE_PATH = path.join(process.cwd(), "server.log");

function createRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

function appendLogLine(payload) {
  try {
    fs.appendFileSync(LOG_FILE_PATH, JSON.stringify(payload) + "\n", "utf8");
  } catch (error) {
    console.error("Falha ao gravar server.log:", error?.message || error);
  }
}

function logInfo(message, meta = {}) {
  const payload = {
    level: "info",
    time: new Date().toISOString(),
    message,
    ...meta
  };
  console.log(JSON.stringify(payload));
  appendLogLine(payload);
}

function logWarn(message, meta = {}) {
  const payload = {
    level: "warn",
    time: new Date().toISOString(),
    message,
    ...meta
  };
  console.warn(JSON.stringify(payload));
  appendLogLine(payload);
}

function logError(message, error, meta = {}) {
  const payload = {
    level: "error",
    time: new Date().toISOString(),
    message,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || null
    },
    ...meta
  };
  console.error(JSON.stringify(payload));
  appendLogLine(payload);
}

const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use((req, res, next) => {
  req.requestId = createRequestId();
  res.setHeader("X-Request-Id", req.requestId);

  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;

    logInfo("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
    });
  });

  next();
});

morgan.token("request-id", (req) => req.requestId || "-");
app.use(
  morgan(":method :url :status :response-time ms reqId=:request-id", {
    skip: () => process.env.NODE_ENV === "production"
  })
);

/* =========================
   CONFIG
========================= */

const PORT = Number(process.env.PORT || 3000);

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

const LICENSE_SECRET =
  process.env.LICENSE_SECRET || "TROQUE_POR_UM_SEGREDO_FORTE_DA_LICENCA";

const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || "TROQUE_POR_UM_SEGREDO_FORTE_DE_ACESSO";

const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "https://osl-video-server-production.up.railway.app";

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "https://preludiojogos.com.br";

const PRODUCT_ID = "osl_ritual_completo";
const PRODUCT_TITLE = "O SextoLugar — Ritual Completo";
const PRODUCT_PRICE = 29.9;
const PRODUCT_CURRENCY = "BRL";

const LICENSE_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ACCESS_VALIDITY_MS = 8 * 60 * 60 * 1000;

const REFERRAL_REWARD_COINS = 10;
const REFERRAL_MIN_WITHDRAW_COINS = 100;
const REFERRAL_WITHDRAW_PIX_VALUE = 90;
const REFERRAL_COMMISSION_PERCENT = 0.31;

const pagamentosAprovados = new Map();

/* =========================
   DISCORD CONFIG
========================= */

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || `${BACKEND_BASE_URL}/discord/callback`;

const DISCORD_ROLE_BUYER_ID = process.env.DISCORD_ROLE_BUYER_ID || "";
const DISCORD_ROLE_AFFILIATE_ID = process.env.DISCORD_ROLE_AFFILIATE_ID || "";
const DISCORD_API_BASE = "https://discord.com/api/v10";

/* =========================
   FIREBASE ADMIN
========================= */

function parseServiceAccountFromEnv() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();

  if (!rawJson) {
    throw new Error("FIREBASE_ADMIN_NAO_CONFIGURADO");
  }

  const parsed = JSON.parse(rawJson);

  if (parsed.private_key) {
    parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  }

  return parsed;
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.firestore();
  }

  const serviceAccount = parseServiceAccountFromEnv();

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: serviceAccount.project_id || serviceAccount.projectId,
      clientEmail: serviceAccount.client_email || serviceAccount.clientEmail,
      privateKey: serviceAccount.private_key
    })
  });

  return admin.firestore();
}

let db = null;

try {
  db = initFirebaseAdmin();
  logInfo("firebase_admin_initialized");
} catch (error) {
  console.error("Firebase Admin não configurado:", error.message);
}

/* =========================
   GENERIC HELPERS
========================= */

function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      logError("route_error", error, {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl
      });
      next(error);
    }
  };
}

function sendError(res, status, error, extra = {}) {
  return res.status(status).json({
    ok: false,
    error,
    ...extra
  });
}

function ensureDb(res) {
  if (!db) {
    sendError(res, 500, "FIREBASE_ADMIN_NAO_CONFIGURADO");
    return false;
  }
  return true;
}

function ensureDiscordConfigured(res) {
  if (
    !DISCORD_CLIENT_ID ||
    !DISCORD_CLIENT_SECRET ||
    !DISCORD_BOT_TOKEN ||
    !DISCORD_GUILD_ID ||
    !DISCORD_REDIRECT_URI
  ) {
    sendError(res, 500, "DISCORD_NAO_CONFIGURADO");
    return false;
  }
  return true;
}

function normalizeUid(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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

/* =========================
   TOKEN HELPERS
========================= */

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

  if (signature !== expectedSignature) {
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

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

function requireGameAccess(req, res, next) {
  const accessToken = getBearerToken(req);

  if (!accessToken) {
    return sendError(res, 401, "ACESSO_NAO_INFORMADO");
  }

  const verification = verifySignedToken(accessToken, ACCESS_TOKEN_SECRET);

  if (!verification.valid) {
    return sendError(res, 401, "ACESSO_INVALIDO", {
      detail: verification.error || null
    });
  }

  const payload = verification.payload;

  if (payload.token_type !== "game_access" || payload.product !== PRODUCT_ID) {
    return sendError(res, 401, "ACESSO_NEGADO");
  }

  req.gameAccess = payload;
  next();
}

/* =========================
   BUSINESS HELPERS
========================= */

function generateExternalReference() {
  return `OSL-${Date.now()}-${crypto
    .randomBytes(5)
    .toString("hex")
    .toUpperCase()}`;
}

function generateLicenseCode(paymentId, externalReference, email) {
  const raw = `${paymentId}|${externalReference}|${email}|${PRODUCT_ID}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();

  return `OSL-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(
    8,
    12
  )}-${hash.slice(12, 16)}-${hash.slice(16, 20)}`;
}

function buildDiscordState(payload) {
  return signPayload(
    {
      ...payload,
      iat: Date.now(),
      exp: Date.now() + 10 * 60 * 1000
    },
    ACCESS_TOKEN_SECRET
  );
}

function buildDiscordAuthorizeUrl({ uid, next = "/painel.html" }) {
  const state = buildDiscordState({
    uid: normalizeUid(uid),
    next: sanitizeNextPath(next)
  });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: "identify guilds.join",
    prompt: "consent",
    state
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function buildDiscordAvatarUrl(discordUser) {
  const userId = String(discordUser?.id || "").trim();
  const avatar = String(discordUser?.avatar || "").trim();

  if (!userId || !avatar) return "";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
}

/* =========================
   HTTP CLIENTS
========================= */

async function mercadoPagoFetch(url, options = {}) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("MP_ACCESS_TOKEN_NAO_CONFIGURADO");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function discordApiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text || null;
  }

  return { response, data };
}

async function discordTokenFetch(bodyParams) {
  const body = new URLSearchParams(bodyParams);

  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "O-SextoLugar/1.0"
    },
    body: body.toString()
  });

  const rawText = await response.text();

  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { raw: rawText };
  }

  return { response, data, rawText };
}

/* =========================
   DISCORD SERVICE
========================= */

async function exchangeDiscordCode(code) {
  const payload = {
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    redirect_uri: DISCORD_REDIRECT_URI
  };

  let result = await discordTokenFetch(payload);

  if (result.response.status === 429) {
    const retryFromJson = Number(result.data?.retry_after || 0);
    const retryFromHeader = Number(result.response.headers.get("retry-after") || 0);
    const waitSeconds = Math.max(retryFromJson, retryFromHeader, 30);

    await sleep(waitSeconds * 1000);
    result = await discordTokenFetch(payload);
  }

  return result;
}

async function getDiscordCurrentUser(userAccessToken) {
  return discordApiFetch(`${DISCORD_API_BASE}/users/@me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${userAccessToken}`
    }
  });
}

async function addDiscordUserToGuild({ discordUserId, userAccessToken }) {
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      },
      body: JSON.stringify({
        access_token: userAccessToken
      })
    }
  );
}

async function addDiscordRoleToMember({ discordUserId, roleId }) {
  if (!roleId) {
    return { response: { ok: true, status: 204 }, data: null };
  }

  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    }
  );
}

async function removeDiscordRoleFromMember({ discordUserId, roleId }) {
  if (!roleId) {
    return { response: { ok: true, status: 204 }, data: null };
  }

  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    }
  );
}

async function getDiscordGuildMember(discordUserId) {
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    }
  );
}

/* =========================
   FIRESTORE SERVICE
========================= */

async function saveDiscordLinkToUser({ uid, discordUser, discordAccessToken }) {
  const userRef = db.collection("users").doc(uid);

  await userRef.set(
    {
      discordLinked: true,
      discordUserId: String(discordUser.id || ""),
      discordUsername: String(discordUser.username || ""),
      discordGlobalName: String(discordUser.global_name || ""),
      discordAvatar: buildDiscordAvatarUrl(discordUser),
      discordAccessToken: String(discordAccessToken || ""),
      discordLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  const snap = await userRef.get();
  return snap.exists ? snap.data() : null;
}

async function getUserProfileByUid(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function getAffiliateProfileByUid(uid) {
  const snap = await db.collection("affiliates").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function saveLicenseRecord(record) {
  const ref = db.collection("licenses").doc(record.licenseCode);

  await ref.set(
    {
      licenseCode: record.licenseCode,
      licenseToken: record.licenseToken,
      paymentId: record.paymentId,
      externalReference: record.externalReference,
      email: record.email,
      nome: record.nome || "",
      product: record.product,
      amount: record.amount,
      currency: record.currency,
      status: "active",
      exp: record.exp,
      boundToUid: "",
      boundToEmail: "",
      firstActivatedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function claimOrValidateLicenseOwnership({ licenseCode, uid, email }) {
  const normalizedUid = normalizeUid(uid);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid) {
    return {
      ok: false,
      status: 400,
      error: "UID_OBRIGATORIO"
    };
  }

  const ref = db.collection("licenses").doc(licenseCode);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (!snap.exists) {
      return {
        ok: false,
        status: 404,
        error: "LICENCA_NAO_ENCONTRADA"
      };
    }

    const license = snap.data();

    if (license.status !== "active") {
      return {
        ok: false,
        status: 401,
        error: "LICENCA_INATIVA"
      };
    }

    if (license.exp && Date.now() > Number(license.exp)) {
      return {
        ok: false,
        status: 401,
        error: "LICENCA_EXPIRADA"
      };
    }

    const boundToUid = normalizeUid(license.boundToUid);
    const boundToEmail = normalizeEmail(license.boundToEmail);

    if (!boundToUid) {
      tx.set(
        ref,
        {
          boundToUid: normalizedUid,
          boundToEmail: normalizedEmail,
          firstActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return {
        ok: true,
        claimedNow: true,
        license: {
          ...license,
          boundToUid: normalizedUid,
          boundToEmail: normalizedEmail
        }
      };
    }

    if (boundToUid === normalizedUid) {
      if (!boundToEmail && normalizedEmail) {
        tx.set(
          ref,
          {
            boundToEmail: normalizedEmail,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }

      return {
        ok: true,
        claimedNow: false,
        license: {
          ...license,
          boundToUid,
          boundToEmail: boundToEmail || normalizedEmail
        }
      };
    }

    return {
      ok: false,
      status: 403,
      error: "LICENCA_JA_VINCULADA_A_OUTRA_CONTA"
    };
  });
}

function generateReferralCodeFromUid(uid) {
  const clean = String(uid || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const base = clean || crypto.randomBytes(4).toString("hex").toUpperCase();
  return `OSL${base.slice(0, 8)}`;
}

async function getAffiliateRefByUid(uid) {
  return db.collection("affiliates").doc(uid);
}

async function getAffiliateByCode(refCode) {
  const code = String(refCode || "").trim().toUpperCase();
  if (!code) return null;

  const snap = await db
    .collection("affiliates")
    .where("refCode", "==", code)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const docSnap = snap.docs[0];
  return {
    id: docSnap.id,
    ref: docSnap.ref,
    data: docSnap.data()
  };
}

async function ensureAffiliateProfile({ uid, email = "", nome = "" }) {
  const normalizedUid = normalizeUid(uid);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid) {
    throw new Error("UID_OBRIGATORIO_AFFILIATE");
  }

  const ref = await getAffiliateRefByUid(normalizedUid);
  const snap = await ref.get();

  if (snap.exists) {
    const current = snap.data();

    await ref.set(
      {
        email: normalizedEmail || current.email || "",
        nome: String(nome || "").trim().slice(0, 80) || current.nome || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const refreshed = await ref.get();
    return refreshed.data();
  }

  const refCode = generateReferralCodeFromUid(normalizedUid);

  await ref.set(
    {
      uid: normalizedUid,
      email: normalizedEmail,
      nome: String(nome || "").trim().slice(0, 80),
      refCode,
      coins: 0,
      referralsApproved: 0,
      referralsPending: 0,
      commissionApproved: 0,
      withdrawableCoins: 0,
      totalPaidOutBRL: 0,
      pixKey: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  const created = await ref.get();
  return created.data();
}

async function registerPendingReferral({
  paymentId = "",
  externalReference = "",
  buyerEmail = "",
  buyerName = "",
  refCode = "",
  referrerUid = "",
  amount = PRODUCT_PRICE
}) {
  if (!refCode || !referrerUid) return;

  const referralId = externalReference || paymentId;
  if (!referralId) return;

  const referralRef = db.collection("referrals").doc(referralId);
  const referralSnap = await referralRef.get();

  if (!referralSnap.exists) {
    await referralRef.set({
      referralId,
      paymentId: String(paymentId || ""),
      externalReference: String(externalReference || ""),
      buyerEmail: normalizeEmail(buyerEmail),
      buyerName: String(buyerName || "").trim().slice(0, 80),
      refCode: String(refCode || "").trim().toUpperCase(),
      referrerUid: String(referrerUid || "").trim(),
      status: "pending",
      coinsAwarded: 0,
      commissionAmount: Number(amount || 0) * REFERRAL_COMMISSION_PERCENT,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection("affiliates").doc(referrerUid).set(
      {
        referralsPending: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }
}

async function approveReferralRewardFromPayment(payment) {
  if (!payment) return;

  const paymentId = String(payment.id || "").trim();
  const externalReference = String(payment.external_reference || "").trim();
  const metadata = payment.metadata || {};

  const refCode = String(metadata.ref_code || "").trim().toUpperCase();
  const referrerUid = String(metadata.referrer_uid || "").trim();

  if (!paymentId || !externalReference || !refCode || !referrerUid) {
    return;
  }

  const referralRef = db.collection("referrals").doc(externalReference);
  const affiliateRef = db.collection("affiliates").doc(referrerUid);

  await db.runTransaction(async (tx) => {
    const referralSnap = await tx.get(referralRef);
    const affiliateSnap = await tx.get(affiliateRef);

    if (!affiliateSnap.exists) {
      throw new Error("AFILIADO_NAO_ENCONTRADO");
    }

    const commissionAmount =
      Number(payment.transaction_amount || PRODUCT_PRICE) *
      REFERRAL_COMMISSION_PERCENT;

    if (!referralSnap.exists) {
      tx.set(referralRef, {
        referralId: externalReference,
        paymentId,
        externalReference,
        buyerEmail: normalizeEmail(
          payment.payer?.email || metadata.customer_email || ""
        ),
        buyerName: String(
          metadata.customer_name || payment.payer?.first_name || ""
        )
          .trim()
          .slice(0, 80),
        refCode,
        referrerUid,
        status: "approved",
        coinsAwarded: REFERRAL_REWARD_COINS,
        commissionAmount,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(
        affiliateRef,
        {
          coins: admin.firestore.FieldValue.increment(REFERRAL_REWARD_COINS),
          withdrawableCoins: admin.firestore.FieldValue.increment(
            REFERRAL_REWARD_COINS
          ),
          referralsApproved: admin.firestore.FieldValue.increment(1),
          referralsPending: admin.firestore.FieldValue.increment(-1),
          commissionApproved: admin.firestore.FieldValue.increment(
            commissionAmount
          ),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return;
    }

    const referral = referralSnap.data();

    if (referral.status === "approved") {
      return;
    }

    tx.set(
      referralRef,
      {
        paymentId,
        status: "approved",
        coinsAwarded: REFERRAL_REWARD_COINS,
        commissionAmount,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    tx.set(
      affiliateRef,
      {
        coins: admin.firestore.FieldValue.increment(REFERRAL_REWARD_COINS),
        withdrawableCoins: admin.firestore.FieldValue.increment(
          REFERRAL_REWARD_COINS
        ),
        referralsApproved: admin.firestore.FieldValue.increment(1),
        referralsPending: admin.firestore.FieldValue.increment(-1),
        commissionApproved: admin.firestore.FieldValue.increment(
          commissionAmount
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}

async function syncDiscordRolesForUid(uid) {
  const normalizedUid = normalizeUid(uid);
  if (!normalizedUid) {
    return {
      ok: false,
      error: "UID_OBRIGATORIO"
    };
  }

  const userProfile = await getUserProfileByUid(normalizedUid);
  if (!userProfile?.discordUserId) {
    return {
      ok: false,
      error: "DISCORD_NAO_VINCULADO"
    };
  }

  const affiliate = await getAffiliateProfileByUid(normalizedUid);
  const discordUserId = String(userProfile.discordUserId || "").trim();

  const shouldHaveBuyerRole =
    !!userProfile.licenseLinked || !!userProfile?.access?.active;
  const shouldHaveAffiliateRole = !!affiliate;

  const guildMemberRes = await getDiscordGuildMember(discordUserId);

  if (!guildMemberRes.response.ok) {
    return {
      ok: false,
      error: "MEMBRO_DISCORD_NAO_ENCONTRADO",
      details: guildMemberRes.data || null
    };
  }

  if (DISCORD_ROLE_BUYER_ID) {
    if (shouldHaveBuyerRole) {
      await addDiscordRoleToMember({
        discordUserId,
        roleId: DISCORD_ROLE_BUYER_ID
      });
    } else {
      await removeDiscordRoleFromMember({
        discordUserId,
        roleId: DISCORD_ROLE_BUYER_ID
      });
    }
  }

  if (DISCORD_ROLE_AFFILIATE_ID) {
    if (shouldHaveAffiliateRole) {
      await addDiscordRoleToMember({
        discordUserId,
        roleId: DISCORD_ROLE_AFFILIATE_ID
      });
    } else {
      await removeDiscordRoleFromMember({
        discordUserId,
        roleId: DISCORD_ROLE_AFFILIATE_ID
      });
    }
  }

  return {
    ok: true,
    discordUserId,
    buyerRoleApplied: !!shouldHaveBuyerRole,
    affiliateRoleApplied: !!shouldHaveAffiliateRole
  };
}

/* =========================
   PAINEL EM TEMPO REAL
========================= */

const PANEL_ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const PANEL_PLAYER_TTL_MS = 1000 * 60 * 2;
const panelRooms = new Map();

function nowIso() {
  return new Date().toISOString();
}

function normalizeRoomId(value) {
  return String(value || "").trim();
}

function normalizePlayerId(value) {
  return String(value || "").trim();
}

function normalizePlayerName(value) {
  return String(value || "").trim().slice(0, 80);
}

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
      sessionActive: false,
      videoActive: false,
      recordingActive: false,
      players: {}
    };
    panelRooms.set(normalizedRoomId, room);
  }

  if (roomName && !room.name) room.name = String(roomName).trim();
  if (host && !room.host) room.host = String(host).trim();

  room.updatedAt = nowIso();
  return room;
}

function cleanupPanelRoomPlayers(room) {
  if (!room || !room.players) return;

  const now = Date.now();

  for (const [playerId, player] of Object.entries(room.players)) {
    const lastSeenTime = new Date(
      player.lastSeen || player.updatedAt || room.updatedAt
    ).getTime();

    if (!lastSeenTime || now - lastSeenTime > PANEL_PLAYER_TTL_MS) {
      delete room.players[playerId];
    }
  }
}

function cleanupPanelRooms() {
  const now = Date.now();

  for (const [roomId, room] of panelRooms.entries()) {
    cleanupPanelRoomPlayers(room);

    const lastUpdated = new Date(room.updatedAt || room.createdAt).getTime();
    const playerCount = Object.keys(room.players || {}).length;

    if (
      (!lastUpdated || now - lastUpdated > PANEL_ROOM_TTL_MS) &&
      playerCount === 0 &&
      !room.sessionActive &&
      !room.videoActive &&
      !room.recordingActive
    ) {
      panelRooms.delete(roomId);
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

setInterval(cleanupPanelRooms, 30 * 1000).unref();

/* =========================
   HEALTH / ROOT
========================= */

app.get("/", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "osl-video-server",
    message: "Servidor do O SextoLugar está online.",
    port: PORT
  });
});

app.get("/panel", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OSL Server</title>
    <style>
      body {
        margin: 0;
        background: #050507;
        color: #e6c07b;
        font-family: monospace;
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      .header {
        padding: 20px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        font-size: 18px;
        letter-spacing: 1px;
      }
      .status {
        padding: 16px 20px;
        color: #82d996;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .logs {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        font-size: 12px;
        color: #ccc;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .log {
        margin-bottom: 6px;
        padding: 6px 8px;
        border-left: 2px solid rgba(230,192,123,0.35);
        background: rgba(255,255,255,0.02);
      }
      .ok { color: #82d996; }
      .bad { color: #ff6b6b; }
    </style>
  </head>
  <body>
    <div class="header">OSL VIDEO SERVER</div>
    <div class="status" id="status">Conectando...</div>
    <div class="logs" id="logs"></div>

    <script>
      const statusEl = document.getElementById("status");
      const logsEl = document.getElementById("logs");
      const PORT_VALUE = ${JSON.stringify(PORT)};

      function addLogLine(text) {
        if (!text || !String(text).trim()) return;
        const div = document.createElement("div");
        div.className = "log";
        div.textContent = text;
        logsEl.appendChild(div);
        while (logsEl.children.length > 300) {
          logsEl.removeChild(logsEl.firstChild);
        }
        logsEl.scrollTop = logsEl.scrollHeight;
      }

      async function updateStatus() {
        try {
          const res = await fetch("/health");
          const data = await res.json();
          statusEl.innerHTML =
            '<span class="ok">🟢 ONLINE</span> - Porta ' +
            PORT_VALUE +
            ' - Uptime ' +
            data.uptimeSec +
            's';
        } catch (e) {
          statusEl.innerHTML = '<span class="bad">🔴 OFFLINE</span>';
        }
      }

      const source = new EventSource("/logs/stream");

      source.addEventListener("bootstrap", (event) => {
        try {
          const lines = JSON.parse(event.data);
          logsEl.innerHTML = "";
          lines.forEach(addLogLine);
        } catch (e) {}
      });

      source.addEventListener("log", (event) => {
        addLogLine(event.data);
      });

      source.onerror = () => {
        statusEl.innerHTML = '<span class="bad">🔴 CONEXÃO DE LOG INTERROMPIDA</span>';
      };

      updateStatus();
      setInterval(updateStatus, 3000);
    </script>
  </body>
  </html>
  `);
});

app.get("/logs", (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE_PATH)) {
      return res.json([]);
    }

    const data = fs.readFileSync(LOG_FILE_PATH, "utf-8");
    const lines = data.split("\n").filter(Boolean);
    return res.json(lines);
  } catch {
    return res.json([]);
  }
});

app.get("/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const sendEvent = (event, data) => {
    res.write("event: " + event + "\n");
    res.write("data: " + data + "\n\n");
  };

  const sendLogLine = (line) => {
    if (!line || !String(line).trim()) return;
    sendEvent("log", String(line).replace(/\n/g, " "));
  };

  let lastSize = 0;

  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      const initialData = fs.readFileSync(LOG_FILE_PATH, "utf-8");
      const initialLines = initialData.split("\n").filter(Boolean).slice(-100);
      sendEvent("bootstrap", JSON.stringify(initialLines));
      lastSize = fs.statSync(LOG_FILE_PATH).size;
    } else {
      sendEvent("bootstrap", JSON.stringify([]));
    }
  } catch {
    sendEvent("bootstrap", JSON.stringify([]));
  }

  const watcher = (curr, prev) => {
    try {
      if (!fs.existsSync(LOG_FILE_PATH)) return;

      if (curr.size < lastSize) {
        lastSize = 0;
      }

      if (curr.size > lastSize) {
        const stream = fs.createReadStream(LOG_FILE_PATH, {
          encoding: "utf-8",
          start: lastSize,
          end: curr.size
        });

        let chunk = "";

        stream.on("data", (data) => {
          chunk += data;
        });

        stream.on("end", () => {
          const lines = chunk.split("\n").filter(Boolean);
          lines.forEach(sendLogLine);
          lastSize = curr.size;
        });

        stream.on("error", () => {});
      }
    } catch {}
  };

  if (!fs.existsSync(LOG_FILE_PATH)) {
    try {
      fs.writeFileSync(LOG_FILE_PATH, "", "utf8");
    } catch {}
  }

  fs.watchFile(LOG_FILE_PATH, { interval: 1000 }, watcher);

  const heartbeat = setInterval(() => {
    res.write(": ping\\n\\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    fs.unwatchFile(LOG_FILE_PATH, watcher);
    res.end();
  });
});

app.get("/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "osl-video-server",
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(APP_START_TIME).toISOString(),
    now: new Date().toISOString(),
    firebaseConfigured: !!db,
    environment: process.env.NODE_ENV || "development"
  });
});

/* =========================
   ROTAS DO PAINEL
========================= */

app.post("/game/room/create", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const name = String(req.body?.name || "").trim();
    const host = String(req.body?.host || "").trim();

    if (!roomId) {
      return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    }

    const room = getOrCreatePanelRoom(roomId, name, host);

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_room_create_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_ROOM_CREATE");
  }
});

app.post("/game/player/join", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const playerId = normalizePlayerId(req.body?.playerId);
    const playerName = normalizePlayerName(req.body?.playerName);

    if (!roomId || !playerId) {
      return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");
    }

    const room = getOrCreatePanelRoom(roomId);

    room.players[playerId] = {
      playerId,
      playerName: playerName || "Jogador",
      joinedAt: room.players[playerId]?.joinedAt || nowIso(),
      lastSeen: nowIso()
    };

    room.updatedAt = nowIso();

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_player_join_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_PLAYER_JOIN");
  }
});

app.post("/game/player/leave", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const playerId = normalizePlayerId(req.body?.playerId);

    if (!roomId || !playerId) {
      return sendError(res, 400, "ROOM_ID_E_PLAYER_ID_OBRIGATORIOS");
    }

    const room = panelRooms.get(roomId);

    if (!room) {
      return res.json({ ok: true, room: null });
    }

    delete room.players[playerId];
    room.updatedAt = nowIso();

    cleanupPanelRoomPlayers(room);

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_player_leave_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_PLAYER_LEAVE");
  }
});

app.post("/game/session/start", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);

    if (!roomId) {
      return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    }

    const room = getOrCreatePanelRoom(roomId);
    room.sessionActive = true;
    room.updatedAt = nowIso();

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_session_start_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_SESSION_START");
  }
});

app.post("/game/session/end", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);

    if (!roomId) {
      return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    }

    const room = getOrCreatePanelRoom(roomId);
    room.sessionActive = false;
    room.videoActive = false;
    room.recordingActive = false;
    room.updatedAt = nowIso();

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_session_end_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_SESSION_END");
  }
});

app.post("/game/video", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const active = !!req.body?.active;

    if (!roomId) {
      return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    }

    const room = getOrCreatePanelRoom(roomId);
    room.videoActive = active;
    room.updatedAt = nowIso();

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_video_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_VIDEO");
  }
});

app.post("/game/recording", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body?.roomId);
    const active = !!req.body?.active;

    if (!roomId) {
      return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
    }

    const room = getOrCreatePanelRoom(roomId);
    room.recordingActive = active;
    room.updatedAt = nowIso();

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_recording_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_RECORDING");
  }
});

app.get("/game/room/:roomId", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.params.roomId);
    const room = panelRooms.get(roomId);

    if (!room) {
      return sendError(res, 404, "ROOM_NAO_ENCONTRADA");
    }

    return res.json({
      ok: true,
      room: serializePanelRoom(room)
    });
  } catch (error) {
    logError("game_room_get_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_ROOM_GET");
  }
});

app.get("/game/rooms", (req, res) => {
  try {
    cleanupPanelRooms();

    const rooms = Array.from(panelRooms.values())
      .map(serializePanelRoom)
      .sort((a, b) => {
        const t1 = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const t2 = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return t2 - t1;
      });

    return res.json({
      ok: true,
      rooms
    });
  } catch (error) {
    logError("game_rooms_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_ROOMS");
  }
});

app.post("/game/cleanup", (req, res) => {
  try {
    cleanupPanelRooms();
    return res.json({
      ok: true,
      totalRooms: panelRooms.size
    });
  } catch (error) {
    logError("game_cleanup_error", error, {
      requestId: req.requestId
    });
    return sendError(res, 500, "ERRO_GAME_CLEANUP");
  }
});

/* =========================
   DISCORD ROUTES
========================= */

app.get(
  "/discord/connect",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

    const uid = normalizeUid(req.query.uid);
    const next = sanitizeNextPath(req.query.next || "/painel.html");

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const authUrl = buildDiscordAuthorizeUrl({ uid, next });
    return res.redirect(302, authUrl);
  })
);

app.get(
  "/discord/callback",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();

    if (!code || !state) {
      return res.status(400).send("Parâmetros do Discord ausentes.");
    }

    const stateVerification = verifySignedToken(state, ACCESS_TOKEN_SECRET);

    if (!stateVerification.valid) {
      return res.status(401).send("Estado OAuth inválido ou expirado.");
    }

    const { uid, next } = stateVerification.payload || {};

    if (!normalizeUid(uid)) {
      return res.status(400).send("UID inválido no fluxo do Discord.");
    }

    const tokenRes = await exchangeDiscordCode(code);

    if (!tokenRes.response.ok || !tokenRes.data?.access_token) {
      if (tokenRes.response.status === 429) {
        return res
          .status(429)
          .send("Discord bloqueou temporariamente a autenticação. Aguarde e tente novamente.");
      }

      return res
        .status(500)
        .send("Não foi possível autenticar com o Discord. Verifique os logs do servidor.");
    }

    const discordAccessToken = String(tokenRes.data.access_token || "").trim();
    const meRes = await getDiscordCurrentUser(discordAccessToken);

    if (!meRes.response.ok || !meRes.data?.id) {
      return res.status(500).send("Não foi possível obter os dados do Discord.");
    }

    const discordUser = meRes.data;

    const joinRes = await addDiscordUserToGuild({
      discordUserId: String(discordUser.id || ""),
      userAccessToken: discordAccessToken
    });

    if (![201, 204].includes(Number(joinRes.response.status))) {
      logWarn("discord_join_guild_not_ideal_status", {
        status: joinRes.response.status,
        data: joinRes.data
      });
    }

    await saveDiscordLinkToUser({
      uid: normalizeUid(uid),
      discordUser,
      discordAccessToken
    });

    await syncDiscordRolesForUid(normalizeUid(uid));

    const redirectTarget =
      `${FRONTEND_BASE_URL}${sanitizeNextPath(next)}?discord=connected`;

    return res.redirect(302, redirectTarget);
  })
);

app.get(
  "/discord/status/:uid",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.params.uid);
    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const userProfile = await getUserProfileByUid(uid);

    return res.json({
      ok: true,
      discordLinked: !!userProfile?.discordLinked,
      discordUserId: userProfile?.discordUserId || "",
      discordUsername: userProfile?.discordUsername || "",
      discordGlobalName: userProfile?.discordGlobalName || "",
      discordAvatar: userProfile?.discordAvatar || ""
    });
  })
);

app.post(
  "/discord/sync/:uid",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

    const uid = normalizeUid(req.params.uid);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const result = await syncDiscordRolesForUid(uid);

    if (!result.ok) {
      return sendError(res, 400, result.error, { details: result.details || null });
    }

    return res.json({
      ok: true,
      ...result
    });
  })
);

/* =========================
   PAYMENT ROUTES
========================= */

app.post(
  "/criar-pagamento",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const nome = String(req.body?.nome || "").trim().slice(0, 80);
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase()
      .slice(0, 160);

    const refCodeInput = String(req.body?.refCode || "").trim().toUpperCase();

    if (!nome) {
      return sendError(res, 400, "NOME_OBRIGATORIO");
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(res, 400, "EMAIL_INVALIDO");
    }

    let referralData = null;

    if (refCodeInput) {
      referralData = await getAffiliateByCode(refCodeInput);

      if (!referralData) {
        return sendError(res, 400, "CODIGO_INDICACAO_INVALIDO");
      }

      if (normalizeEmail(referralData.data.email) === email) {
        return sendError(res, 400, "AUTOINDICACAO_NAO_PERMITIDA");
      }
    }

    const externalReference = generateExternalReference();

    const body = {
      items: [
        {
          id: PRODUCT_ID,
          title: PRODUCT_TITLE,
          description:
            "Experiência digital imersiva com cartas psicológicas e interação em grupo ao vivo",
          category_id: "entertainment",
          quantity: 1,
          currency_id: PRODUCT_CURRENCY,
          unit_price: PRODUCT_PRICE
        }
      ],
      payer: {
        name: nome,
        email
      },
      metadata: {
        product_id: PRODUCT_ID,
        customer_name: nome,
        customer_email: email,
        ref_code: referralData?.data?.refCode || "",
        referrer_uid: referralData?.id || ""
      },
      external_reference: externalReference,
      notification_url: `${BACKEND_BASE_URL}/webhook`,
      back_urls: {
        success: `${FRONTEND_BASE_URL}/sucesso.html`,
        failure: `${FRONTEND_BASE_URL}/erro.html`,
        pending: `${FRONTEND_BASE_URL}/pendente.html`
      },
      auto_return: "approved",
      statement_descriptor: "SEXTO LUGAR"
    };

    const { response, data } = await mercadoPagoFetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "ERRO_MP_CRIAR_PAGAMENTO",
        details: data,
        message:
          data?.message ||
          data?.error ||
          data?.cause?.[0]?.description ||
          data?.cause?.[0]?.code ||
          "Falha ao criar preferência no Mercado Pago"
      });
    }

    if (referralData) {
      await registerPendingReferral({
        paymentId: "",
        externalReference,
        buyerEmail: email,
        buyerName: nome,
        refCode: referralData.data.refCode,
        referrerUid: referralData.id,
        amount: PRODUCT_PRICE
      });
    }

    return res.json({
      ok: true,
      url: data.init_point,
      sandbox_url: data.sandbox_init_point || null,
      ref: externalReference,
      referralApplied: !!referralData
    });
  })
);

app.get("/status-pagamento/:ref", (req, res) => {
  try {
    const ref = String(req.params.ref || "").trim();

    if (!ref) {
      return sendError(res, 400, "REF_OBRIGATORIA");
    }

    const pagamento = pagamentosAprovados.get(ref);

    if (!pagamento) {
      return res.json({
        ok: true,
        found: false,
        approved: false
      });
    }

    return res.json({
      ok: true,
      found: true,
      approved: true,
      paymentId: pagamento.paymentId,
      status: pagamento.status,
      ref: pagamento.ref
    });
  } catch (error) {
    return sendError(res, 500, "ERRO_INTERNO_STATUS_PAGAMENTO");
  }
});

/* =========================
   LICENSE / ACCESS ROUTES
========================= */

app.post(
  "/emitir-licenca",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const paymentId = String(req.body?.paymentId || "").trim();

    if (!paymentId) {
      return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");
    }

    const { response, data: payment } = await mercadoPagoFetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { method: "GET" }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "ERRO_MP_CONSULTAR_PAGAMENTO",
        details: payment
      });
    }

    if (payment.status !== "approved") {
      return sendError(res, 400, "PAGAMENTO_NAO_APROVADO", {
        statusAtual: payment.status || null
      });
    }

    await approveReferralRewardFromPayment(payment);

    const transactionAmount = Number(payment.transaction_amount || 0);
    if (Math.abs(transactionAmount - PRODUCT_PRICE) > 0.01) {
      return sendError(res, 400, "VALOR_DIVERGENTE", {
        valor_recebido: transactionAmount
      });
    }

    const email = String(
      payment.payer?.email || payment.metadata?.customer_email || ""
    )
      .trim()
      .toLowerCase();

    const nome = String(
      payment.metadata?.customer_name || payment.payer?.first_name || ""
    )
      .trim()
      .slice(0, 80);

    const externalReference = String(payment.external_reference || "").trim();

    if (!email || !externalReference) {
      return sendError(res, 400, "DADOS_INSUFICIENTES_PARA_LICENCA");
    }

    const licenseCode = generateLicenseCode(
      payment.id,
      externalReference,
      email
    );

    const payload = {
      token_type: "license",
      product: PRODUCT_ID,
      product_title: PRODUCT_TITLE,
      payment_id: String(payment.id),
      external_reference: externalReference,
      email,
      nome,
      license_code: licenseCode,
      amount: PRODUCT_PRICE,
      currency: PRODUCT_CURRENCY,
      iat: Date.now(),
      exp: Date.now() + LICENSE_VALIDITY_MS
    };

    const licenseToken = signPayload(payload, LICENSE_SECRET);

    await saveLicenseRecord({
      licenseCode,
      licenseToken,
      paymentId: String(payment.id),
      externalReference,
      email,
      nome,
      product: PRODUCT_ID,
      amount: PRODUCT_PRICE,
      currency: PRODUCT_CURRENCY,
      exp: payload.exp
    });

    return res.json({
      ok: true,
      licenseToken,
      licenseCode,
      email,
      ref: externalReference
    });
  })
);

app.post("/verificar-licenca", (req, res) => {
  try {
    const licenseToken = String(req.body?.licenseToken || "").trim();

    if (!licenseToken) {
      return sendError(res, 400, "LICENCA_OBRIGATORIA");
    }

    const verification = verifySignedToken(licenseToken, LICENSE_SECRET);

    if (!verification.valid) {
      return sendError(res, 401, verification.error || "LICENCA_INVALIDA");
    }

    const payload = verification.payload;

    if (payload.token_type !== "license" || payload.product !== PRODUCT_ID) {
      return sendError(res, 401, "LICENCA_NAO_AUTORIZADA");
    }

    return res.json({
      ok: true,
      valid: true,
      licenseCode: payload.license_code,
      email: payload.email,
      nome: payload.nome || "",
      product: payload.product
    });
  } catch (error) {
    return sendError(res, 500, "ERRO_INTERNO_VERIFICAR_LICENCA");
  }
});

app.post(
  "/validar-codigo-licenca",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
    const uid = normalizeUid(req.body?.uid);
    const email = normalizeEmail(req.body?.email);

    if (!licenseCode) {
      return sendError(res, 400, "CODIGO_OBRIGATORIO");
    }

    const ownership = await claimOrValidateLicenseOwnership({
      licenseCode,
      uid,
      email
    });

    if (!ownership.ok) {
      return sendError(res, ownership.status, ownership.error);
    }

    const license = ownership.license;

    return res.json({
      ok: true,
      valid: true,
      claimedNow: ownership.claimedNow,
      licenseCode: license.licenseCode,
      email: license.email,
      nome: license.nome || "",
      product: license.product,
      boundToUid: license.boundToUid || "",
      boundToEmail: license.boundToEmail || ""
    });
  })
);

app.post("/emitir-acesso", (req, res) => {
  try {
    const licenseToken = String(req.body?.licenseToken || "").trim();

    if (!licenseToken) {
      return sendError(res, 400, "LICENCA_OBRIGATORIA");
    }

    const verification = verifySignedToken(licenseToken, LICENSE_SECRET);

    if (!verification.valid) {
      return sendError(res, 401, "LICENCA_INVALIDA", {
        detail: verification.error || null
      });
    }

    const license = verification.payload;

    if (license.token_type !== "license" || license.product !== PRODUCT_ID) {
      return sendError(res, 401, "LICENCA_NAO_AUTORIZADA");
    }

    const accessPayload = {
      token_type: "game_access",
      product: PRODUCT_ID,
      license_code: license.license_code,
      email: license.email,
      nome: license.nome || "",
      uid: "",
      iat: Date.now(),
      exp: Date.now() + ACCESS_VALIDITY_MS
    };

    const accessToken = signPayload(accessPayload, ACCESS_TOKEN_SECRET);

    return res.json({
      ok: true,
      accessToken,
      expiresAt: accessPayload.exp
    });
  } catch (error) {
    return sendError(res, 500, "ERRO_INTERNO_EMITIR_ACESSO");
  }
});

app.post(
  "/emitir-acesso-por-codigo",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
    const uid = normalizeUid(req.body?.uid);
    const email = normalizeEmail(req.body?.email);

    if (!licenseCode) {
      return sendError(res, 400, "CODIGO_OBRIGATORIO");
    }

    const ownership = await claimOrValidateLicenseOwnership({
      licenseCode,
      uid,
      email
    });

    if (!ownership.ok) {
      return sendError(res, ownership.status, ownership.error);
    }

    const license = ownership.license;

    const accessPayload = {
      token_type: "game_access",
      product: PRODUCT_ID,
      license_code: license.licenseCode,
      email: license.email,
      nome: license.nome || "",
      uid,
      iat: Date.now(),
      exp: Date.now() + ACCESS_VALIDITY_MS
    };

    const accessToken = signPayload(accessPayload, ACCESS_TOKEN_SECRET);

    return res.json({
      ok: true,
      accessToken,
      expiresAt: accessPayload.exp,
      email: license.email,
      nome: license.nome || "",
      licenseCode: license.licenseCode,
      claimedNow: ownership.claimedNow
    });
  })
);

app.post("/verificar-acesso", (req, res) => {
  try {
    const accessToken = String(req.body?.accessToken || "").trim();

    if (!accessToken) {
      return sendError(res, 400, "ACESSO_OBRIGATORIO");
    }

    const verification = verifySignedToken(accessToken, ACCESS_TOKEN_SECRET);

    if (!verification.valid) {
      return sendError(res, 401, verification.error || "ACESSO_INVALIDO");
    }

    const payload = verification.payload;

    if (payload.token_type !== "game_access" || payload.product !== PRODUCT_ID) {
      return sendError(res, 401, "ACESSO_NEGADO");
    }

    return res.json({
      ok: true,
      liberado: true,
      email: payload.email,
      nome: payload.nome || "",
      licenseCode: payload.license_code,
      uid: payload.uid || ""
    });
  } catch (error) {
    return sendError(res, 500, "ERRO_INTERNO_VERIFICAR_ACESSO");
  }
});

/* =========================
   AFFILIATE ROUTES
========================= */

app.post(
  "/afiliado/garantir",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.body?.uid);
    const email = normalizeEmail(req.body?.email);
    const nome = String(req.body?.nome || "").trim().slice(0, 80);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const affiliate = await ensureAffiliateProfile({ uid, email, nome });

    return res.json({
      ok: true,
      affiliate: {
        uid: affiliate.uid,
        nome: affiliate.nome || "",
        email: affiliate.email || "",
        refCode: affiliate.refCode,
        referralLink: `${FRONTEND_BASE_URL}/vendas.html?ref=${affiliate.refCode}`,
        coins: Number(affiliate.coins || 0),
        withdrawableCoins: Number(affiliate.withdrawableCoins || 0),
        referralsApproved: Number(affiliate.referralsApproved || 0),
        referralsPending: Number(affiliate.referralsPending || 0),
        commissionApproved: Number(affiliate.commissionApproved || 0),
        totalPaidOutBRL: Number(affiliate.totalPaidOutBRL || 0),
        pixKey: affiliate.pixKey || ""
      }
    });
  })
);

app.get(
  "/afiliado/perfil/:uid",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.params.uid);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const ref = db.collection("affiliates").doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
      return sendError(res, 404, "AFILIADO_NAO_ENCONTRADO");
    }

    const affiliate = snap.data();

    return res.json({
      ok: true,
      affiliate: {
        uid: affiliate.uid,
        nome: affiliate.nome || "",
        email: affiliate.email || "",
        refCode: affiliate.refCode,
        referralLink: `${FRONTEND_BASE_URL}/vendas.html?ref=${affiliate.refCode}`,
        coins: Number(affiliate.coins || 0),
        withdrawableCoins: Number(affiliate.withdrawableCoins || 0),
        referralsApproved: Number(affiliate.referralsApproved || 0),
        referralsPending: Number(affiliate.referralsPending || 0),
        commissionApproved: Number(affiliate.commissionApproved || 0),
        totalPaidOutBRL: Number(affiliate.totalPaidOutBRL || 0),
        pixKey: affiliate.pixKey || ""
      }
    });
  })
);

app.get(
  "/afiliado/historico/:uid",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.params.uid);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const referralsSnap = await db
      .collection("referrals")
      .where("referrerUid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const withdrawsSnap = await db
      .collection("withdrawRequests")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const history = [];

    referralsSnap.forEach((docSnap) => {
      const data = docSnap.data();
      history.push({
        id: docSnap.id,
        type:
          data.status === "approved"
            ? "indicação aprovada"
            : "indicação pendente",
        status: data.status || "pending",
        buyerEmail: data.buyerEmail || "",
        buyerName: data.buyerName || "",
        coinsAwarded: Number(data.coinsAwarded || 0),
        commissionAmount: Number(data.commissionAmount || 0),
        externalReference:
          data.externalReference || data.referralId || docSnap.id,
        createdAt: formatFirestoreDate(data.approvedAt || data.createdAt)
      });
    });

    withdrawsSnap.forEach((docSnap) => {
      const data = docSnap.data();
      history.push({
        id: docSnap.id,
        type: "saque",
        status: data.status || "pending",
        buyerEmail: "",
        buyerName: "",
        coinsAwarded: -Math.abs(Number(data.coinsUsed || 0)),
        commissionAmount: Number(data.amountBRL || 0),
        externalReference: docSnap.id,
        createdAt: formatFirestoreDate(data.createdAt)
      });
    });

    history.sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    return res.json({
      ok: true,
      history: history.slice(0, 100)
    });
  })
);

app.get(
  "/afiliado/saques/:uid",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.params.uid);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const snap = await db
      .collection("withdrawRequests")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const withdrawals = snap.docs.map((docSnap) => {
      const item = docSnap.data();

      return {
        id: docSnap.id,
        uid: item.uid || "",
        nome: item.nome || "",
        email: item.email || "",
        pixKey: item.pixKey || "",
        coinsUsed: Number(item.coinsUsed || 0),
        amountBRL: Number(item.amountBRL || 0),
        status: item.status || "pending",
        createdAt: formatFirestoreDate(item.createdAt),
        updatedAt: formatFirestoreDate(item.updatedAt)
      };
    });

    return res.json({
      ok: true,
      withdrawals
    });
  })
);

app.post(
  "/afiliado/pix",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.body?.uid);
    const pixKey = String(req.body?.pixKey || "").trim().slice(0, 160);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    if (!pixKey) {
      return sendError(res, 400, "PIX_OBRIGATORIO");
    }

    await db.collection("affiliates").doc(uid).set(
      {
        pixKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      pixKey
    });
  })
);

app.post(
  "/afiliado/solicitar-saque",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const uid = normalizeUid(req.body?.uid);

    if (!uid) {
      return sendError(res, 400, "UID_OBRIGATORIO");
    }

    const affiliateRef = db.collection("affiliates").doc(uid);
    const snap = await affiliateRef.get();

    if (!snap.exists) {
      return sendError(res, 404, "AFILIADO_NAO_ENCONTRADO");
    }

    const affiliate = snap.data();
    const withdrawableCoins = Number(affiliate.withdrawableCoins || 0);
    const pixKey = String(affiliate.pixKey || "").trim();

    if (!pixKey) {
      return sendError(res, 400, "PIX_NAO_CADASTRADO");
    }

    if (withdrawableCoins < REFERRAL_MIN_WITHDRAW_COINS) {
      return sendError(res, 400, "SALDO_INSUFICIENTE", {
        minCoins: REFERRAL_MIN_WITHDRAW_COINS
      });
    }

    const withdrawRef = db.collection("withdrawRequests").doc();

    await db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(affiliateRef);
      const latest = affiliateSnap.data();
      const latestCoins = Number(latest.withdrawableCoins || 0);

      if (latestCoins < REFERRAL_MIN_WITHDRAW_COINS) {
        throw new Error("SALDO_INSUFICIENTE");
      }

      tx.set(withdrawRef, {
        uid,
        nome: latest.nome || "",
        email: latest.email || "",
        pixKey: latest.pixKey || "",
        coinsUsed: REFERRAL_MIN_WITHDRAW_COINS,
        amountBRL: REFERRAL_WITHDRAW_PIX_VALUE,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(
        affiliateRef,
        {
          withdrawableCoins: admin.firestore.FieldValue.increment(
            -REFERRAL_MIN_WITHDRAW_COINS
          ),
          totalPaidOutBRL: admin.firestore.FieldValue.increment(
            REFERRAL_WITHDRAW_PIX_VALUE
          ),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });

    return res.json({
      ok: true,
      message: "Solicitação de saque criada com sucesso.",
      amountBRL: REFERRAL_WITHDRAW_PIX_VALUE,
      coinsUsed: REFERRAL_MIN_WITHDRAW_COINS
    });
  })
);

/* =========================
   WEBHOOK / TEST ROUTES
========================= */

app.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const type = body.type || body.topic || null;
    const paymentId =
      body.data?.id ||
      body["data.id"] ||
      body.id ||
      req.query["data.id"] ||
      req.query.id ||
      null;

    if (type === "payment" && paymentId) {
      const { response, data: payment } = await mercadoPagoFetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        { method: "GET" }
      );

      if (!response.ok) {
        return res.sendStatus(200);
      }

      const status = String(payment.status || "").trim();
      const ref = String(payment.external_reference || "").trim();

      if (status === "approved" && ref) {
        pagamentosAprovados.set(ref, {
          approved: true,
          paymentId: String(payment.id),
          status,
          ref,
          updatedAt: Date.now()
        });

        if (db) {
          try {
            await approveReferralRewardFromPayment(payment);
          } catch (refError) {
            logError("approve_referral_reward_error", refError, {
              ref,
              paymentId
            });
          }
        }
      }
    }

    return res.sendStatus(200);
  })
);

app.get(
  "/teste-pagamento/:paymentId",
  asyncHandler(async (req, res) => {
    const paymentId = String(req.params.paymentId || "").trim();

    if (!paymentId) {
      return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");
    }

    const { response, data } = await mercadoPagoFetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { method: "GET" }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "ERRO_MP_CONSULTAR_PAGAMENTO",
        details: data
      });
    }

    return res.json({
      ok: true,
      data
    });
  })
);

app.get(
  "/forcar-afiliado/:paymentId",
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;

    const paymentId = String(req.params.paymentId || "").trim();

    if (!paymentId) {
      return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");
    }

    const { response, data: payment } = await mercadoPagoFetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { method: "GET" }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "ERRO_MP_CONSULTAR_PAGAMENTO",
        details: payment
      });
    }

    if (String(payment.status || "").trim() !== "approved") {
      return sendError(res, 400, "PAGAMENTO_NAO_APROVADO", {
        statusAtual: payment.status || null
      });
    }

    await approveReferralRewardFromPayment(payment);

    return res.json({
      ok: true,
      message: "Afiliado aprovado manualmente"
    });
  })
);

/* =========================
   LIVEKIT ROUTES
========================= */

app.get(
  "/token",
  requireGameAccess,
  asyncHandler(async (req, res) => {
    const room = req.query.room;
    const user = req.query.user;

    if (!room || !user) {
      return sendError(res, 400, "ROOM_E_USER_OBRIGATORIOS");
    }

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return sendError(res, 500, "LIVEKIT_NAO_CONFIGURADO");
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(user),
      name: String(user)
    });

    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true
    });

    const token = await at.toJwt();

    return res.json({
      ok: true,
      token
    });
  })
);

/* =========================
   FALLBACKS
========================= */

app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: "ROTA_NAO_ENCONTRADA",
    requestId: req.requestId || null
  });
});

app.use((err, req, res, next) => {
  logError("express_error_middleware", err, {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl
  });

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    ok: false,
    error: "ERRO_INTERNO",
    requestId: req.requestId
  });
});

/* =========================
   START
========================= */

const server = app.listen(PORT, "0.0.0.0", () => {
  logInfo("server_started", {
    port: PORT,
    backendBaseUrl: BACKEND_BASE_URL
  });
});

function shutdown(signal) {
  logWarn("shutdown_started", { signal });

  server.close((err) => {
    if (err) {
      logError("shutdown_error", err, { signal });
      process.exit(1);
    }

    logInfo("shutdown_completed", { signal });
    process.exit(0);
  });

  setTimeout(() => {
    logWarn("shutdown_forced", { signal });
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
