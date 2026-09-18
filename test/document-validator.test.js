"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyValidationRules,
  applyRegistrationValidationRules,
  normalizeExtracted,
  parseIsoDate,
} = require("../services/document-validator");

function withAutoApproval(value, fn) {
  const previous = process.env.DOC_VALIDATOR_ALLOW_AUTO_APPROVE;
  if (value == null) delete process.env.DOC_VALIDATOR_ALLOW_AUTO_APPROVE;
  else process.env.DOC_VALIDATOR_ALLOW_AUTO_APPROVE = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.DOC_VALIDATOR_ALLOW_AUTO_APPROVE;
    else process.env.DOC_VALIDATOR_ALLOW_AUTO_APPROVE = previous;
  }
}

function recentIsoDate(monthsAgo = 0) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - monthsAgo);
  return date.toISOString().slice(0, 10);
}

test("datas ISO impossíveis não são normalizadas silenciosamente", () => {
  assert.equal(parseIsoDate("2026-02-29"), null);
  assert.equal(parseIsoDate("2024-02-29"), "2024-02-29");
  assert.equal(parseIsoDate("2026-13-01"), null);
});

test("campo isUltimoAno exige boolean true, não aceita string truthy", () => {
  assert.equal(normalizeExtracted({ isUltimoAno: "false" }).isUltimoAno, false);
  assert.equal(normalizeExtracted({ isUltimoAno: true }).isUltimoAno, true);
});

test("triagem estudantil de alta confiança exige revisão humana por padrão", () => {
  const extracted = {
    curso: "Psicologia",
    cursoElegivel: true,
    situacao: "ativo",
    isUltimoAno: true,
    dataEmissao: recentIsoDate(),
    nome: "Ana Beatriz Souza",
    cpf: "12345678901",
    instituicao: "Universidade Exemplo",
  };

  const result = withAutoApproval(null, () => applyValidationRules({
    extracted,
    expectedName: "Ana Beatriz Souza",
    expectedCpf: "12345678901",
    llmConfidence: 0.99,
  }));

  assert.equal(result.decision, "manual-review");
  assert.match(result.reasons.join(" "), /revisão humana/i);
});

test("aprovação automática documental requer opt-in explícito", () => {
  const extracted = {
    curso: "Psicologia",
    cursoElegivel: true,
    situacao: "ativo",
    isUltimoAno: true,
    dataEmissao: recentIsoDate(),
    nome: "Ana Beatriz Souza",
    cpf: "12345678901",
    instituicao: "Universidade Exemplo",
  };

  const result = withAutoApproval("true", () => applyValidationRules({
    extracted,
    expectedName: "Ana Beatriz Souza",
    expectedCpf: "12345678901",
    llmConfidence: 0.99,
  }));

  assert.equal(result.decision, "approved");
});

test("registro profissional de alta confiança também exige revisão humana", () => {
  const result = withAutoApproval(null, () => applyRegistrationValidationRules({
    extracted: {
      dataInscricao: recentIsoDate(2),
      situacao: "ativo",
      nome: "Maria Silva",
      conselho: "CRP",
      registro: "06/12345",
      tipoDocumento: "carteira",
    },
    expectedName: "Maria Silva",
    expectedConselho: "CRP",
    expectedRegistro: "06/12345",
    llmConfidence: 0.98,
  }));

  assert.equal(result.decision, "manual-review");
  assert.match(result.reasons.join(" "), /revisão humana/i);
});

test("dados de identidade ausentes nunca passam pela aprovação automática", () => {
  const result = withAutoApproval("true", () => applyRegistrationValidationRules({
    extracted: {
      dataInscricao: recentIsoDate(2),
      situacao: "ativo",
      nome: "",
      conselho: "CRP",
      registro: "",
      tipoDocumento: "outro",
    },
    expectedName: "Maria Silva",
    expectedConselho: "CRP",
    expectedRegistro: "06/12345",
    llmConfidence: 0.99,
  }));

  assert.notEqual(result.decision, "approved");
  assert.match(result.reasons.join(" "), /nome do profissional não identificado/i);
});
