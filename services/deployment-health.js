"use strict";
const { signPayload, verifySignedToken } = require("./auth");
function healthToken(secret, now = Date.now()) {
  return signPayload({ token_type: "deployment_health", scope: "health:read", exp: now + 5 * 60_000 }, secret);
}
function canReadHealth(req, secret = process.env.DEPLOYMENT_HEALTH_SECRET) {
  const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const result = verifySignedToken(token, secret);
  return result.valid && result.payload.token_type === "deployment_health" && result.payload.scope === "health:read";
}
module.exports = { healthToken, canReadHealth };
