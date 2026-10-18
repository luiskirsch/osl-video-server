"use strict";
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { getDb, ensureDb } = require("../services/firestore");
const { verifyFirebaseToken, verifySignedToken } = require("../services/auth");
const { store } = require("../services/clinical-mfa-store");
const { ACCESS_TOKEN_SECRET, THERAPY_ADMIN_EMAILS, THERAPY_RT_EMAILS } = require("../config");
const { asyncHandler, sendError } = require("../utils");

async function eligibleActor(uid, decoded) {
  const profile = await getDb().collection("therapists").doc(uid).get();
  if (profile.exists) return { label: profile.data().displayName || decoded.email || uid };
  if (decoded.email_verified !== true) return null;
  const email = String(decoded.email || "").trim().toLowerCase();
  if (THERAPY_ADMIN_EMAILS.includes(email) || THERAPY_RT_EMAILS.includes(email)) return { label: email };
  const assignments = await getDb().collection("therapy_rt_assignments").where("email", "==", email).limit(1).get();
  if (!assignments.empty && assignments.docs[0].data().active !== false) return { label: email };
  // Patient-side portal accounts (paciente, colaborador, aluno): optional factor.
  const [patient, student] = await Promise.all([
    getDb().collection("therapy_patient_accounts").doc(uid).get(),
    getDb().collection("therapy_estudantes").where("portalAccountUid", "==", uid).limit(1).get()
  ]);
  if (patient.exists || !student.empty) return { label: decoded.email || uid, optional: true };
  return null;
}

function createClinicalMfaRouter({ authenticate = verifyFirebaseToken, available = ensureDb,
  authorize = eligibleActor, mfa = store, signingSecret = ACCESS_TOKEN_SECRET } = {}) {
  const router = express.Router();
  const accountLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10,
    keyGenerator: req => "mfa:" + req.firebaseUid, standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: "MUITAS_TENTATIVAS_2FA" } });
  const identity = asyncHandler(async (req, res, next) => {
    if (!available(res)) return;
    const uid = await authenticate(req, res, { checkRevoked: true });
    if (!uid) return;
    const actor = await authorize(uid, req.verifiedFirebaseToken || {});
    if (!actor) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
    if (req.body?.uid && req.body.uid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
    req.firebaseUid = uid; req.mfaActor = actor;
    return next();
  });
  const action = operation => asyncHandler(async (req, res) => {
    try {
      const result = await operation(req);
      return res.json({ ok: true, ...result });
    } catch (error) {
      // Never serialize cryptographic exceptions, seeds, submitted codes or records.
      if (error.code && Number.isInteger(error.status)) return sendError(res, error.status, error.code);
      return sendError(res, 503, "MFA_TEMPORARIAMENTE_INDISPONIVEL");
    }
  });
  router.get("/therapy/2fa/status", identity, action(async req => {
    const state = await mfa.load(req.firebaseUid);
    const verification = verifySignedToken(String(req.headers["x-therapy-2fa"] || ""), signingSecret);
    const proof = verification.payload || {};
    const sessionValid = !!(state?.twoFactorEnabled && verification.valid && proof.token_type === "twofa_session" &&
      proof.uid === req.firebaseUid && String(proof.version || "legacy") === String(state.twoFactorVersion || "legacy") &&
      proof.auth_time === req.verifiedFirebaseToken?.auth_time);
    const optional = !!req.mfaActor.optional;
    return { required: !optional, enabled: !!state?.twoFactorEnabled, sessionValid,
      recoveryCodesRemaining: Array.isArray(state?.twoFactorRecoveryHashes) ? state.twoFactorRecoveryHashes.length : 0 };
  }));
  router.post("/therapy/2fa/setup", identity, accountLimit, action(req => mfa.setup(req.firebaseUid, req.mfaActor.label, { optional: !!req.mfaActor.optional })));
  router.post("/therapy/2fa/enable", identity, accountLimit, action(req => mfa.enable(req.firebaseUid, String(req.body?.code || "").trim(), req.verifiedFirebaseToken?.auth_time)));
  router.post("/therapy/2fa/verify", identity, accountLimit, action(req => mfa.verify(req.firebaseUid, String(req.body?.code || "").trim(), req.verifiedFirebaseToken?.auth_time)));
  router.post("/therapy/2fa/recovery-codes", identity, accountLimit, action(req => mfa.verify(req.firebaseUid, String(req.body?.code || "").trim(), req.verifiedFirebaseToken?.auth_time, { renewRecovery: true })));
  router.post("/therapy/2fa/recover", identity, accountLimit, action(req => mfa.recover(req.firebaseUid, req.body?.recoveryCode)));
  router.post("/therapy/2fa/disable", identity, accountLimit, (req, res, next) => {
    if (!req.mfaActor.optional) return sendError(res, 403, "MFA_OBRIGATORIO_SEM_DESATIVACAO");
    return next();
  }, action(req => mfa.disable(req.firebaseUid, String(req.body?.code || "").trim())));
  return router;
}
module.exports = createClinicalMfaRouter;
