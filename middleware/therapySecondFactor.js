"use strict";
const admin = require("firebase-admin");
const { getBearerToken } = require("../services/auth");
const { requireSecondFactor } = require("../services/clinical-second-factor");
const { asyncHandler } = require("../utils");

const EXEMPT = new Set(["/therapy/2fa/setup", "/therapy/2fa/enable", "/therapy/2fa/verify", "/therapy/2fa/disable"]);

function createTherapySecondFactor({ authenticate = token => admin.auth().verifyIdToken(token, true),
  enforce = requireSecondFactor } = {}) {
  return asyncHandler(async (req, res, next) => {
    // Express routes accept case variants and an optional trailing slash.
    // The security boundary must recognize precisely the same route variants.
    const route = String(req.path || "").replace(/\/+$/, "").toLowerCase();
    if (!route.startsWith("/therapy/") || EXEMPT.has(route)) return next();
    const token = getBearerToken(req);
    if (!token) return next(); // Public invitation routes use their own signed tokens.
    let decoded;
    try { decoded = await authenticate(token); }
    catch { return next(); } // The destination route produces the canonical auth error.
    req.verifiedFirebaseToken = decoded;
    req.firebaseRevocationChecked = true;
    req.firebaseUid = decoded.uid;
    if (!await enforce(req, res, decoded.uid)) return;
    return next();
  });
}

module.exports = createTherapySecondFactor;
