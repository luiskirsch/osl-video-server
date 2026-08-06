const express = require("express");
const path    = require("path");
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

// POST /admin/delete-user — apaga conta totalmente (Firebase Auth + Firestore).
// Limpa: therapists/{uid}, therapy_patient_accounts/{uid}, e quaisquer subcolecoes
// referenciando o uid. Operacao IRREVERSIVEL — usar so pra reset/desenvolvimento.
//
// Body: { email: string }
// Headers: x-admin-secret: <ADMIN_SECRET>
router.post("/admin/delete-user", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");

  const db = getDb();
  const summary = { email, deletedFrom: [], errors: [] };

  // 1. Buscar UID pelo email no Firebase Auth
  let uid = null;
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    uid = userRecord.uid;
    summary.uid = uid;
  } catch (e) {
    summary.errors.push({ step: "getUserByEmail", error: e.message });
    return res.json({ ok: true, summary, note: "User nao existe no Firebase Auth — nada a deletar" });
  }

  // 2. Deletar doc de therapist (se existir)
  try {
    const tDoc = await db.collection("therapists").doc(uid).get();
    if (tDoc.exists) {
      await db.collection("therapists").doc(uid).delete();
      summary.deletedFrom.push("therapists/" + uid);
    }
  } catch (e) { summary.errors.push({ step: "deleteTherapistDoc", error: e.message }); }

  // 3. Deletar doc de patient account (se existir)
  try {
    const pDoc = await db.collection("therapy_patient_accounts").doc(uid).get();
    if (pDoc.exists) {
      await db.collection("therapy_patient_accounts").doc(uid).delete();
      summary.deletedFrom.push("therapy_patient_accounts/" + uid);
    }
  } catch (e) { summary.errors.push({ step: "deletePatientAccountDoc", error: e.message }); }

  // 4. Deletar notas do paciente (subcolecao independente)
  try {
    const notesSnap = await db.collection("therapy_patient_notes").where("patientAccountUid", "==", uid).limit(500).get();
    if (!notesSnap.empty) {
      const batch = db.batch();
      notesSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      summary.deletedFrom.push(`therapy_patient_notes (${notesSnap.size} docs)`);
    }
  } catch (e) { summary.errors.push({ step: "deletePatientNotes", error: e.message }); }

  // 5. Deletar do Firebase Auth (irrev)
  try {
    await admin.auth().deleteUser(uid);
    summary.deletedFrom.push("firebase-auth");
  } catch (e) { summary.errors.push({ step: "deleteAuthUser", error: e.message }); }

  logInfo("admin_delete_user", { email, uid, deletedFrom: summary.deletedFrom });
  return res.json({ ok: true, summary });
}));

// GET /admin/env-check — lista quais env vars estão setadas (sem leak de valor).
// Usado pelo health-check.sh do frontend / debug pós-deploy. Requer ADMIN_SECRET.
router.get("/admin/env-check", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const VARS = [
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL",
    "ACCESS_TOKEN_SECRET", "LICENSE_SECRET", "ADMIN_SECRET", "EMPRESA_JWT_SECRET",
    "THERAPY_ADMIN_EMAILS", "FRONTEND_BASE_URL", "THERAPY_FRONTEND_BASE",
    "RESEND_API_KEY", "EMAIL_FROM",
    "MP_ACCESS_TOKEN", "MP_WEBHOOK_SECRET", "MP_WEBHOOK_REQUIRE_SIG",
    "MP_ACCESS_TOKEN_JOGO", "MP_ACCESS_TOKEN_THERAPY",
    "MP_WEBHOOK_SECRET_JOGO", "MP_WEBHOOK_SECRET_THERAPY",
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

// CSP específica pro admin.html — mais permissiva que a API (permite inline scripts
// do painel), mas ainda restrita: só 'self' e a URL do próprio backend em connect-src.
const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://osl-video-server-production.up.railway.app",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'"
].join("; ");

// GET /system-core — serve o painel admin.
// adminLimiter (3 req/10min) protege contra varredura de URL.
router.get("/system-core", adminLimiter, (req, res) => {
  res.setHeader("Content-Security-Policy", ADMIN_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(__dirname, "..", "admin.html"));
});

module.exports = router;
