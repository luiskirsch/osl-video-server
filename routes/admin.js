const express = require("express");
const admin  = require("firebase-admin");
const { logInfo } = require("../logger");
const { asyncHandler, sendError, normalizeUid, normalizeEmail } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { requireAdmin, signPayload, generateLicenseCode } = require("../services/auth");
const { PRODUCT_ID, PRODUCT_PRICE, PRODUCT_CURRENCY, PRODUCT_TITLE, LICENSE_SECRET, LICENSE_VALIDITY_MS } = require("../config");

const router = express.Router();

// POST /admin/licenca/criar
router.post("/admin/licenca/criar", requireAdmin, asyncHandler(async (req, res) => {
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
router.post("/admin/licenca/desvincular", requireAdmin, asyncHandler(async (req, res) => {
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

module.exports = router;
