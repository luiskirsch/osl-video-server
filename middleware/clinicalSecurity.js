"use strict";

// Apply before parsers, rate limits and routers so errors cannot be cached either.
function clinicalSecurity(req, res, next) {
  const path = String(req.path || "");
  if (/^\/(?:therapy|institution|rt|empresa|public)(?:\/|$)/i.test(path)) {
    req.requireFirebaseRevocationCheck = true;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.vary("Authorization");
  }
  next();
}

module.exports = clinicalSecurity;
