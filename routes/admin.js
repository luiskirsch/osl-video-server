const express = require("express");
const rateLimit = require("express-rate-limit");
const admin  = require("firebase-admin");
const { logInfo, logWarn } = require("../logger");
const { asyncHandler, sendError, normalizeUid, normalizeEmail } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { requireAdmin, signPayload, generateLicenseCode } = require("../services/auth");
const { PRODUCT_ID, PRODUCT_PRICE, PRODUCT_CURRENCY, PRODUCT_TITLE, LICENSE_SECRET, LICENSE_VALIDITY_MS, ADMIN_SECRET } = require("../config");

const router = express.Router();

// Security #6: rate limit em /admin/* — 3 tentativas/10min/IP impede brute force do secret.
const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_ADMIN", hint: "Aguarde 10 min antes de tentar de novo" }
});

// Security #6: verifica força do ADMIN_SECRET na inicialização. Avisa se for fraco/curto.
(function checkAdminSecretStrength() {
  if (!ADMIN_SECRET) {
    logWarn("admin_secret_missing", { hint: "Defina ADMIN_SECRET com 32+ chars random no Railway" });
    return;
  }
  if (ADMIN_SECRET.length < 32) {
    logWarn("admin_secret_weak", { length: ADMIN_SECRET.length, hint: "Use 32+ chars random" });
  }
})();

// POST /admin/licenca/criar
router.post("/admin/licenca/criar", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
  const email       = normalizeEmail(req.body?.email || "");
  const nome        = String(req.body?.nome || "").trim().slice(0, 80);
  const boundToUid  = normalizeUid(req.body?.boundToUid || "");

  if (!licenseCode) return sendError(res, 400, "CODIGO_OBRIGATORIO");

  const payload = {
    token_type: "license", product: PRODUCT_ID,
    license_code: licenseCode, email, nome,
    payment_id: "admin_manual", external_reference: "admin_manual",
    amount: PRODUCT_PRICE, currency: PRODUCT_CURRENCY,
    iat: Date.now(), exp: Date.now() + LICENSE_VALIDITY_MS
  };

  const licenseToken = signPayload(payload, LICENSE_SECRET);
  const db = getDb();

  await db.collection("licenses").doc(licenseCode).set(
    {
      licenseCode, licenseToken,
      paymentId: "admin_manual", externalReference: "admin_manual",
      email, nome, product: PRODUCT_ID,
      amount: PRODUCT_PRICE, currency: PRODUCT_CURRENCY,
      status: "active", exp: payload.exp,
      boundToUid: boundToUid || "", boundToEmail: boundToUid ? email : "",
      firstActivatedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  logInfo("admin_licenca_criada", { licenseCode, email, boundToUid: boundToUid || "nenhum" });
  return res.json({ ok: true, licenseCode, email, nome, product: PRODUCT_ID });
}));

// POST /admin/licenca/desvincular
router.post("/admin/licenca/desvincular", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
  if (!licenseCode) return sendError(res, 400, "CODIGO_OBRIGATORIO");

  const db  = getDb();
  const ref  = db.collection("licenses").doc(licenseCode);
  const snap = await ref.get();

  if (!snap.exists) return sendError(res, 404, "LICENCA_NAO_ENCONTRADA");

  await ref.set({ boundToUid: "", boundToEmail: "", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  logInfo("admin_licenca_desvinculada", { licenseCode });
  return res.json({ ok: true, licenseCode });
}));

// GET /admin/env-check — lista quais env vars estão setadas (sem leak de valor).
// Usado pelo health-check.sh do frontend / debug pós-deploy. Requer ADMIN_SECRET.
router.get("/admin/env-check", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const VARS = [
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL",
    "ACCESS_TOKEN_SECRET", "LICENSE_SECRET", "ADMIN_SECRET",
    "THERAPY_ADMIN_EMAILS", "FRONTEND_BASE_URL", "THERAPY_FRONTEND_BASE",
    "RESEND_API_KEY", "EMAIL_FROM",
    "MP_ACCESS_TOKEN", "MP_WEBHOOK_SECRET", "MP_WEBHOOK_REQUIRE_SIG",
    "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "ANTHROPIC_API_KEY",
    "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_PUBLIC_URL",
    "ZAPI_INSTANCE_ID", "ZAPI_CLIENT_TOKEN", "ZAPI_SECURITY_TOKEN", "ZAPI_BASE_URL",
    "CFP_VALIDATOR_PROVIDER", "IDWALL_API_KEY", "CONFIRADOC_API_KEY",
    "ASAAS_WEBHOOK_TOKEN",
    "REMINDER_LOOKAHEAD_HOURS",
    "THERAPY_TRIAL_DAYS", "THERAPY_TRIAL_DAYS_PROFISSIONAL", "THERAPY_TRIAL_DAYS_RECEM_FORMADO",
    "THERAPY_PLAN_AMOUNT", "THERAPY_PLAN_PROFISSIONAL_AMOUNT", "THERAPY_PLAN_RECEM_FORMADO_AMOUNT",
    "RECORDING_LAYOUT_URL"
  ];
  const status = {};
  for (const v of VARS) {
    const value = process.env[v];
    status[v] = {
      set: !!value && value.length > 0,
      length: value ? value.length : 0
    };
  }
  return res.json({ ok: true, env: status, nodeEnv: process.env.NODE_ENV, appEnv: process.env.APP_ENV });
}));

module.exports = router;
