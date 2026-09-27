"use strict";

const EMPLOYMENT_TYPES = Object.freeze(["clt", "pj", "estagiario", "aprendiz", "estatutario", "outro"]);

function normalizeEmploymentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return EMPLOYMENT_TYPES.includes(normalized) ? normalized : null;
}

function normalizeNr1Scope(value) {
  if (value === true || value === "included") return "included";
  if (value === false || value === "excluded") return "excluded";
  return "technical_review";
}

function publicEligibility(data = {}) {
  return {
    employmentType: normalizeEmploymentType(data.employmentType),
    benefitEligible: data.benefitEligible !== false,
    nr1Scope: normalizeNr1Scope(data.nr1Scope)
  };
}

module.exports = { EMPLOYMENT_TYPES, normalizeEmploymentType, normalizeNr1Scope, publicEligibility };
