"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  benefitMonth, usageDocumentId, activeCoveredEntries,
  calculateExtraQuote, validPricingConfig
} = require("../services/corporate-benefit");

test("mês do benefício usa horário de São Paulo na virada", () => {
  assert.equal(benefitMonth(Date.parse("2026-10-01T02:59:59Z")), "2026-09");
  assert.equal(benefitMonth(Date.parse("2026-10-01T03:00:00Z")), "2026-10");
});

test("documento de uso identifica empresa, colaborador e mês", () => {
  assert.equal(usageDocumentId("campi", "employee_1", "2026-09"), "campi_employee_1_2026-09");
  assert.throws(() => usageDocumentId("../../a", "b", "2026-09"));
});

test("reservas pendentes expiradas não consomem o saldo", () => {
  const entries = {
    old: { status: "pending", expiresAt: 99 },
    current: { status: "pending", expiresAt: 101 },
    approved: { status: "approved", expiresAt: null },
    canceled: { status: "canceled", expiresAt: null }
  };
  assert.deepEqual(Object.keys(activeCoveredEntries(entries, 100)), ["current", "approved"]);
});

test("preço extra exige todos os parâmetros homologados; não embute CPP nem taxa presumida", () => {
  const cfg = {
    version: "campi-2026-01", approved: true, netPsychologistCents: 6000,
    workerWithholdingRate: 0.11, employerContributionRate: 0,
    simplesEffectiveRate: 0.06, gatewayPercentRate: 0.0099,
    gatewayFixedCents: 0, otherFixedCents: 0
  };
  assert.equal(validPricingConfig(cfg), true);
  const quote = calculateExtraQuote(cfg);
  assert.equal(quote.available, true);
  assert.equal(quote.breakdown.grossRpaCents, 6742);
  assert.equal(quote.totalCents, 7249);
  assert.equal(calculateExtraQuote({ ...cfg, simplesEffectiveRate: 0.155 }).totalCents, 8074);
  assert.equal(calculateExtraQuote({ ...cfg, approved: false }), null);
  assert.equal(calculateExtraQuote({ ...cfg, gatewayPercentRate: undefined }), null);
  assert.equal(validPricingConfig({ ...cfg, simplesEffectiveRate: 1 }), false);
});
