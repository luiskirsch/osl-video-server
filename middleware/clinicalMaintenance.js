"use strict";

function isClinicalMaintenance(env = process.env) {
  return env.CLINICAL_MAINTENANCE === "true";
}

function clinicalMaintenance(req, res, next) {
  if (!isClinicalMaintenance() || ["/", "/health", "/internal/health", "/therapy/health", "/.well-known/security.txt"].includes(req.path)) return next();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "60");
  return res.status(503).json({ ok: false, error: "MANUTENCAO_PROGRAMADA", message: "O serviço está temporariamente em manutenção. Tente novamente em alguns minutos." });
}

module.exports = clinicalMaintenance;
module.exports.isClinicalMaintenance = isClinicalMaintenance;
