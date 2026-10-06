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

// Acolhimento de urgência fica registrado no mesmo documento, mas nunca
// conta para a franquia nem para o banco.
const URGENT_MAX_PER_EMPLOYEE_MONTH = 2;

function urgentEntriesFor(entries, employeeId, requestIdToIgnore = null, now = Date.now()) {
  return Object.entries(entries || {}).filter(([id, e]) => id !== requestIdToIgnore && e?.urgent
    && (!employeeId || e.employeeId === employeeId)
    && ["pending", "approved", "completed"].includes(e.status)
    && (e.status !== "pending" || Number(e.expiresAt) > now)).length;
}

function activeCoveredEntries(entries, now = Date.now()) {
  return Object.fromEntries(Object.entries(entries || {}).filter(([, entry]) => {
    if (!entry || entry.urgent || !["pending", "approved", "completed"].includes(entry.status)) return false;
    return entry.status !== "pending" || Number(entry.expiresAt) > now;
  }));
}

// Modelo de cobertura por empresa. "per_employee" (padrão): franquia mensal
// por colaborador. "pool": banco mensal compartilhado pela equipe, com teto
// por pessoa e uma reserva para quem já está em acompanhamento.
const POOL_DEFAULT_PER_EMPLOYEE_MAX = 4;
const POOL_CONTINUITY_RESERVE_RATE = 0.2;
const POOL_ALERT_RATE = 0.8;

function benefitPolicy(company = {}) {
  const poolSize = Number(company.benefitPool?.monthlySessions);
  if (company.benefitModel === "pool" && Number.isInteger(poolSize) && poolSize > 0) {
    const perEmployee = Number(company.benefitPool?.perEmployeeMax);
    return {
      model: "pool",
      poolSize,
      perEmployeeMax: Number.isInteger(perEmployee) && perEmployee > 0 ? perEmployee : POOL_DEFAULT_PER_EMPLOYEE_MAX,
      continuityReserve: Math.ceil(poolSize * POOL_CONTINUITY_RESERVE_RATE)
    };
  }
  return { model: "per_employee", perEmployeeMax: MONTHLY_INCLUDED_SESSIONS };
}

function poolUsageDocumentId(companyId, month) {
  if (!/^[A-Za-z0-9_-]+$/.test(companyId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("BENEFIT_KEY_INVALIDA");
  }
  return `${companyId}_pool_${month}`;
}

function previousBenefitMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// Em acompanhamento = já teve sessão coberta aprovada/realizada neste mês
// ou no anterior. Essas pessoas usam a reserva de continuidade do banco.
function inContinuity(employeeId, ...entryMaps) {
  return entryMaps.some(map => Object.values(map || {}).some(e =>
    e?.employeeId === employeeId && ["approved", "completed"].includes(e.status)));
}

// Decide se uma nova sessão entra no banco. `entries` = entradas ativas do
// mês (activeCoveredEntries); devolve { covered, remaining, used, reason }.
function poolDecision(policy, entries, employeeId, continuity) {
  const all = Object.values(entries || {});
  const used = all.length;
  const employeeUsed = all.filter(e => e?.employeeId === employeeId).length;
  if (employeeUsed >= policy.perEmployeeMax) {
    return { covered: false, used, remaining: Math.max(0, policy.poolSize - used), reason: "LIMITE_PESSOAL_DO_BANCO" };
  }
  const ceiling = continuity ? policy.poolSize : policy.poolSize - policy.continuityReserve;
  if (used >= ceiling) {
    return { covered: false, used, remaining: Math.max(0, policy.poolSize - used), reason: "BANCO_ESGOTADO" };
  }
  return { covered: true, used: used + 1, remaining: policy.poolSize - used - 1, reason: null };
}

function poolAlertDue(policy, usedAfter, alreadyAlerted) {
  return !alreadyAlerted && usedAfter >= Math.ceil(policy.poolSize * POOL_ALERT_RATE);
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
  benefitPolicy,
  poolUsageDocumentId,
  previousBenefitMonth,
  inContinuity,
  poolDecision,
  poolAlertDue,
  activeCoveredEntries,
  URGENT_MAX_PER_EMPLOYEE_MONTH,
  urgentEntriesFor,
  requiresActiveBenefitAtApproval,
  calculateExtraQuote,
  validPricingConfig
};
