const express = require("express");
const path    = require("path");
const rateLimit = require("express-rate-limit");
const admin  = require("firebase-admin");
const { logInfo, logWarn } = require("../logger");
const { asyncHandler, sendError, normalizeUid, normalizeEmail } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { requireAdmin, signPayload, generateLicenseCode } = require("../services/auth");
const { PRODUCT_ID, PRODUCT_PRICE, PRODUCT_CURRENCY, PRODUCT_TITLE, LICENSE_SECRET, LICENSE_VALIDITY_MS, ADMIN_SECRET } = require("../config");
const featureFlags  = require("../services/featureFlags");
const experiments   = require("../services/experiments");
const liveService   = require("../services/liveService");
const worldState    = require("../services/worldState");
const discoveriesSvc = require("../services/discoveries");

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

// ── Feature Flags (admin) ─────────────────────────────────────────────────────

// GET /admin/feature-flags — lista todos os flags
router.get("/admin/feature-flags", adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  const flags = await featureFlags.listFlags();
  return res.json({ ok: true, flags });
}));

// PUT /admin/feature-flags/:name — cria ou atualiza um flag
// Body: { enabled, rollout, whitelist, blacklist, description }
router.put("/admin/feature-flags/:name", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const name = String(req.params.name || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  if (!name) return sendError(res, 400, "FLAG_NAME_INVALIDO");

  await featureFlags.setFlag(name, req.body || {});
  return res.json({ ok: true, name });
}));

// DELETE /admin/feature-flags/:name — remove um flag
router.delete("/admin/feature-flags/:name", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return sendError(res, 400, "FLAG_NAME_INVALIDO");

  await featureFlags.deleteFlag(name);
  return res.json({ ok: true, name });
}));

// POST /admin/feature-flags/cache/invalidate — força limpeza de cache (útil em staging)
router.post("/admin/feature-flags/cache/invalidate", adminLimiter, requireAdmin, (_req, res) => {
  featureFlags.invalidateCache();
  return res.json({ ok: true });
});

// ── Experiments (admin) ───────────────────────────────────────────────────────

// GET /admin/experiments — lista todos os experimentos
router.get("/admin/experiments", adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  const exps = await experiments.listExperiments();
  return res.json({ ok: true, experiments: exps });
}));

// PUT /admin/experiments/:name — cria ou atualiza experimento
// Body: { description, enabled, variants, allocation, overrides, blacklist }
router.put("/admin/experiments/:name", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const name = String(req.params.name || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  if (!name) return sendError(res, 400, "EXPERIMENT_NAME_INVALIDO");

  const { variants } = req.body || {};
  if (variants && !Array.isArray(variants)) return sendError(res, 400, "VARIANTS_DEVE_SER_ARRAY");

  await experiments.setExperiment(name, req.body || {});
  return res.json({ ok: true, name });
}));

// DELETE /admin/experiments/:name — remove experimento
router.delete("/admin/experiments/:name", adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return sendError(res, 400, "EXPERIMENT_NAME_INVALIDO");

  await experiments.deleteExperiment(name);
  return res.json({ ok: true, name });
}));

// POST /admin/experiments/cache/invalidate
router.post("/admin/experiments/cache/invalidate", adminLimiter, requireAdmin, (_req, res) => {
  experiments.invalidateCache();
  return res.json({ ok: true });
});

// GET /system-core — serve o painel admin.
// adminLimiter (3 req/10min) protege contra varredura de URL.
router.get("/system-core", adminLimiter, (req, res) => {
  res.setHeader("Content-Security-Policy", ADMIN_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(__dirname, "..", "admin.html"));
});

// ── Seasons ───────────────────────────────────────────────────────────────────

router.get('/admin/seasons', requireAdmin, asyncHandler(async (_req, res) => {
  const db   = getDb();
  const snap = await db.collection('seasons').orderBy('startAt', 'desc').get();
  const seasons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return res.json({ ok: true, seasons });
}));

router.put('/admin/seasons/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, theme, startAt, endAt, active, packIds, bonusXpMultiplier } = req.body;

  const doc = {
    name:              String(name || '').slice(0, 100),
    description:       String(description || '').slice(0, 500),
    theme:             String(theme || 'default').slice(0, 50),
    startAt:           startAt ? new Date(startAt) : new Date(),
    endAt:             endAt   ? new Date(endAt)   : new Date(Date.now() + 30 * 86400000),
    active:            active !== false,
    packIds:           Array.isArray(packIds) ? packIds.map(String) : [],
    bonusXpMultiplier: Number(bonusXpMultiplier) || 1.0,
    updatedAt:         new Date(),
  };

  const db  = getDb();
  const ref = db.collection('seasons').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    await ref.update(doc);
  } else {
    await ref.set({ ...doc, createdAt: new Date() });
  }

  liveService.invalidate('season');
  logInfo('admin_season_saved', { id });
  return res.json({ ok: true, id });
}));

router.delete('/admin/seasons/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  await db.collection('seasons').doc(req.params.id).delete();
  liveService.invalidate('season');
  logInfo('admin_season_deleted', { id: req.params.id });
  return res.json({ ok: true });
}));

// ── Live Events ───────────────────────────────────────────────────────────────

router.get('/admin/live-events', requireAdmin, asyncHandler(async (_req, res) => {
  const db   = getDb();
  const snap = await db.collection('live_events').orderBy('startAt', 'desc').get();
  const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return res.json({ ok: true, events });
}));

router.put('/admin/live-events/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, type, startAt, endAt, active, bonusCardPackId, bonusXp } = req.body;

  const doc = {
    name:            String(name || '').slice(0, 100),
    description:     String(description || '').slice(0, 500),
    type:            String(type || 'timed').slice(0, 50),
    startAt:         startAt ? new Date(startAt) : new Date(),
    endAt:           endAt   ? new Date(endAt)   : new Date(Date.now() + 7 * 86400000),
    active:          active !== false,
    bonusCardPackId: bonusCardPackId ? String(bonusCardPackId).slice(0, 100) : null,
    bonusXp:         Number(bonusXp) || 0,
    updatedAt:       new Date(),
  };

  const db  = getDb();
  const ref = db.collection('live_events').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    await ref.update(doc);
  } else {
    await ref.set({ ...doc, createdAt: new Date() });
  }

  liveService.invalidate('events');
  logInfo('admin_live_event_saved', { id });
  return res.json({ ok: true, id });
}));

router.delete('/admin/live-events/:id', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  await db.collection('live_events').doc(req.params.id).delete();
  liveService.invalidate('events');
  logInfo('admin_live_event_deleted', { id: req.params.id });
  return res.json({ ok: true });
}));

// ── Daily Ritual ──────────────────────────────────────────────────────────────

// Força geração do ritual de hoje (útil pra testar sem esperar a primeira request)
router.post('/admin/daily-ritual/generate', requireAdmin, asyncHandler(async (_req, res) => {
  liveService.invalidate('daily');
  const daily = await liveService.getDailyRitual();
  return res.json({ ok: true, daily });
}));

// ── World State ───────────────────────────────────────────────────────────────

router.get('/admin/world', requireAdmin, asyncHandler(async (_req, res) => {
  const state = await worldState.getWorldState();
  return res.json({ ok: true, world: state });
}));

router.put('/admin/world', requireAdmin, asyncHandler(async (req, res) => {
  const { communityProgress, currentMissionId, unlockedContent } = req.body || {};
  const patch = {};
  if (communityProgress  !== undefined) patch.communityProgress  = Math.min(1, Math.max(0, Number(communityProgress)));
  if (currentMissionId   !== undefined) patch.currentMissionId   = currentMissionId ? String(currentMissionId) : null;
  if (Array.isArray(unlockedContent))   patch.unlockedContent    = unlockedContent;
  await worldState.setWorldState(patch);
  worldState.invalidate();
  logInfo('admin_world_state_updated', patch);
  return res.json({ ok: true });
}));

// ── Community Missions ────────────────────────────────────────────────────────

router.get('/admin/world/missions', requireAdmin, asyncHandler(async (_req, res) => {
  const missions = await worldState.listMissions();
  return res.json({ ok: true, missions });
}));

router.post('/admin/world/missions', requireAdmin, asyncHandler(async (req, res) => {
  const { id, name, description, goal, unit, rewardContent } = req.body || {};
  try {
    await worldState.createMission({ id, name, description, goal, unit, rewardContent });
    logInfo('admin_mission_created', { id });
    return res.status(201).json({ ok: true, id });
  } catch (e) {
    if (e.code === 400) return sendError(res, 400, e.message);
    throw e;
  }
}));

router.put('/admin/world/missions/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const patch   = req.body || {};
  await worldState.updateMission(id, patch);
  worldState.invalidate();
  logInfo('admin_mission_updated', { id });
  return res.json({ ok: true, id });
}));

// ── Discoveries (Rumores) ─────────────────────────────────────────────────────

router.get('/admin/discoveries', requireAdmin, asyncHandler(async (_req, res) => {
  const list = await discoveriesSvc.listDiscoveries();
  return res.json({ ok: true, discoveries: list });
}));

router.post('/admin/discoveries', requireAdmin, asyncHandler(async (req, res) => {
  try {
    await discoveriesSvc.createDiscovery(req.body || {});
    logInfo('admin_discovery_created', { id: req.body?.id });
    return res.status(201).json({ ok: true, id: req.body?.id });
  } catch (e) {
    if (e.code === 400) return sendError(res, 400, e.message);
    throw e;
  }
}));

router.put('/admin/discoveries/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  await discoveriesSvc.updateDiscovery(id, req.body || {});
  logInfo('admin_discovery_updated', { id });
  return res.json({ ok: true, id });
}));

module.exports = router;
