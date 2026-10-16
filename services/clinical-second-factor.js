"use strict";
const { verifySignedToken } = require("./auth");
const { ACCESS_TOKEN_SECRET } = require("../config");
const { getDb } = require("./firestore");
const { sendError } = require("../utils");

function twoFactorVersion(profile) { return String(profile?.twoFactorVersion || "legacy"); }

function createSecondFactorCheck({ loadProfile = async uid => {
  const db = getDb();
  if (!db) throw new Error("FIREBASE_ADMIN_NAO_CONFIGURADO");
  const snap = await db.collection("therapists").doc(uid).get();
  return snap.exists ? snap.data() : null;
}, secret = ACCESS_TOKEN_SECRET } = {}) {
  return async function requireSecondFactor(req, res, uid) {
    const profile = await loadProfile(uid);
    if (!profile?.twoFactorEnabled) return true;
    const token = String(req.headers["x-therapy-2fa"] || "").trim();
    if (!token) { sendError(res, 401, "TWOFA_REQUIRED"); return false; }
    const verification = verifySignedToken(token, secret);
    const payload = verification.payload || {};
    if (!verification.valid || payload.token_type !== "twofa_session" || payload.uid !== uid ||
        String(payload.version || "legacy") !== twoFactorVersion(profile)) {
      sendError(res, 401, "TWOFA_SESSION_INVALID"); return false;
    }
    req.therapyTwoFactor = { uid, verified: true };
    return true;
  };
}

module.exports = { createSecondFactorCheck, requireSecondFactor: createSecondFactorCheck(), twoFactorVersion };
