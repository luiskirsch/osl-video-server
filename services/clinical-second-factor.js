"use strict";
const { verifySignedToken } = require("./auth");
const { ACCESS_TOKEN_SECRET } = require("../config");
const { loadMfaProfile } = require("./clinical-mfa-store");
const { sendError } = require("../utils");

function twoFactorVersion(profile) { return String(profile?.twoFactorVersion || "legacy"); }

function createSecondFactorCheck({ loadProfile = loadMfaProfile, secret = ACCESS_TOKEN_SECRET } = {}) {
  return async function requireSecondFactor(req, res, uid, { required = false } = {}) {
    const profile = await loadProfile(uid);
    if (!profile?.twoFactorEnabled) {
      if (required || profile) { sendError(res, 401, "TWOFA_ENROLLMENT_REQUIRED"); return false; }
      return true;
    }
    const token = String(req.headers["x-therapy-2fa"] || "").trim();
    if (!token) { sendError(res, 401, "TWOFA_REQUIRED"); return false; }
    const verification = verifySignedToken(token, secret);
    const payload = verification.payload || {};
    if (!verification.valid || payload.token_type !== "twofa_session" || payload.uid !== uid ||
        String(payload.version || "legacy") !== twoFactorVersion(profile) ||
        (Number.isSafeInteger(req.verifiedFirebaseToken?.auth_time) && payload.auth_time !== req.verifiedFirebaseToken.auth_time)) {
      sendError(res, 401, "TWOFA_SESSION_INVALID"); return false;
    }
    req.therapyTwoFactor = { uid, verified: true };
    return true;
  };
}

module.exports = { createSecondFactorCheck, requireSecondFactor: createSecondFactorCheck(), twoFactorVersion };
