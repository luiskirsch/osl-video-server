"use strict";
const { timingSafeStringEqual } = require("../services/auth");
function hasStagingAccess(req) {
  const secret = process.env.STAGING_ACCESS_TOKEN || "";
  const provided = String(req.headers?.["x-staging-token"] || "");
  return secret.length >= 32 && !!provided && timingSafeStringEqual(secret, provided);
}
function stagingAccess(req, res, next) {
  if (require("../config").APP_ENV !== "staging") return next();
  const remote = req.socket?.remoteAddress;
  if (req.path === "/health" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
      && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-proto"]) return next();
  if (hasStagingAccess(req)) return next();
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).json({ ok: false, error: "STAGING_AUTH_REQUIRED" });
}
module.exports = stagingAccess;
module.exports.hasStagingAccess = hasStagingAccess;
