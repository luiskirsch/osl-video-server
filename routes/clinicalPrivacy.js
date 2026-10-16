"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { verifyFirebaseToken } = require("../services/auth");
const { ensureDb, getDb } = require("../services/firestore");
const { asyncHandler, sendError } = require("../utils");

function createClinicalPrivacyRouter(dependencies = {}) {
  const authenticate = dependencies.authenticate || verifyFirebaseToken;
  const database = dependencies.getDb || getDb;
  const configured = dependencies.ensureDb || ensureDb;
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10,
    standardHeaders: true, legacyHeaders: false });

  // This records a request for review. It never deletes clinical records or accounts.
  router.post("/therapy/conta/solicitar-exclusao", limiter, asyncHandler(async (req, res) => {
    const uid = await authenticate(req, res, { checkRevoked: true });
    if (!uid || !configured(res)) return;
    const identity = req.verifiedFirebaseToken;
    const email = String(identity?.email || "").trim().toLowerCase();
    if (!email) return sendError(res, 403, "EMAIL_OBRIGATORIO");
    if ((req.body?.uid && req.body.uid !== uid) ||
        (req.body?.email && String(req.body.email).trim().toLowerCase() !== email)) {
      return sendError(res, 403, "IDENTIDADE_DIVERGENTE");
    }
    const db = database();
    const [professional, patient] = await Promise.all([
      db.collection("therapists").doc(uid).get(),
      db.collection("therapy_patient_accounts").doc(uid).get()
    ]);
    if (!professional.exists && !patient.exists) {
      return sendError(res, 403, "CONTA_NAO_REGISTRADA");
    }
    try {
      await db.collection("therapy_deletion_requests").doc(uid).create({
        uid, email, requestedAt: new Date(), status: "pending"
      });
    } catch (error) {
      // Repeated requests must not overwrite review status or the original date.
      if (error.code !== 6 && error.code !== "already-exists") throw error;
    }
    return res.status(202).json({ ok: true, status: "received" });
  }));
  return router;
}

module.exports = createClinicalPrivacyRouter;
