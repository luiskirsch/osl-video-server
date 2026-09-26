"use strict";

const MONTHLY_INCLUDED_SESSIONS = 2;
const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

function benefitMonth(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) throw new Error("HORARIO_INVALIDO");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE, year: "numeric", month: "2-digit"
  }).formatToParts(date);
  return `${parts.find(x => x.type === "year").value}-${parts.find(x => x.type === "month").value}`;
}

function usageDocumentId(companyId, employeeId, month) {
  if (!/^[A-Za-z0-9_-]+$/.test(companyId) || !/^[A-Za-z0-9_-]+$/.test(employeeId)
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("BENEFIT_KEY_INVALIDA");
  return `${companyId}_${employeeId}_${month}`;
}

function activeCoveredEntries(entries, now = Date.now()) {
  return Object.fromEntries(Object.entries(entries || {}).filter(([, entry]) => {
    if (!entry || !["pending", "approved", "completed"].includes(entry.status)) return false;
    return entry.status !== "pending" || Number(entry.expiresAt) > now;
  }));
}

function requiresActiveBenefitAtApproval(benefit) {
  // A cobertura é concedida pela empresa; a consulta extra já paga é uma
  // compra do paciente e deve continuar atendível após desativação do plano.
  return benefit?.mode === "covered";
}

function calculateExtraQuote(config) {
  if (!config || config.approved !== true || !config.version) return null;
  const net = Number(config.netPsychologistCents);
  const withholding = Number(config.workerWithholdingRate);
  const employer = Number(config.employerContributionRate);
  const tax = Number(config.simplesEffectiveRate);
  const gateway = Number(config.gatewayPercentRate);
  const gatewayFixed = Number(config.gatewayFixedCents);
  const otherFixed = Number(config.otherFixedCents);
  if (!Number.isInteger(net) || net <= 0 || !Number.isFinite(withholding)
      || !Number.isFinite(employer) || !Number.isFinite(tax) || !Number.isFinite(gateway)
      || !Number.isInteger(gatewayFixed) || !Number.isInteger(otherFixed)
      || withholding < 0 || withholding >= 1 || employer < 0 || employer > 1
      || tax < 0 || tax >= 1 || gateway < 0 || gateway >= 1
      || tax + gateway >= 1 || gatewayFixed < 0 || otherFixed < 0) return null;
  const grossRpaCents = Math.ceil(net / (1 - withholding));
  const employerCostCents = Math.ceil(grossRpaCents * (1 + employer));
  const totalCents = Math.ceil((employerCostCents + gatewayFixed + otherFixed) / (1 - tax - gateway));
  return {
    available: true,
    version: String(config.version),
    totalCents,
    currency: "BRL",
    breakdown: {
      netPsychologistCents: net,
      grossRpaCents,
      employerCostCents,
      workerWithholdingRate: withholding,
      employerContributionRate: employer,
      simplesEffectiveRate: tax,
      gatewayPercentRate: gateway,
      gatewayFixedCents: gatewayFixed,
      otherFixedCents: otherFixed
    }
  };
}

function validPricingConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(String(config.version || ""))) return false;
  return Boolean(calculateExtraQuote({ ...config, approved: true }));
}

module.exports = {
  MONTHLY_INCLUDED_SESSIONS,
  benefitMonth,
  usageDocumentId,
  activeCoveredEntries,
  requiresActiveBenefitAtApproval,
  calculateExtraQuote,
  validPricingConfig
};
