"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nr1 = require("../services/nr1-workplace");

const units = nr1.normalizeUnits(["Porto Alegre", "Várzea Grande"]);
const answers = Object.fromEntries(nr1.QUESTIONS.map(item => [item.id, 3]));

test("o instrumento cobre 19 itens de condições de trabalho, sem informação clínica", () => {
  assert.equal(nr1.QUESTIONS.length, 19);
  assert.equal(nr1.validateAnswers(answers).d1, 3);
  assert.equal(nr1.validateAnswers({ ...answers, extra: 1 }), null);
  assert.equal(nr1.validateAnswers({ ...answers, d1: 0 }), null);
  assert.equal(nr1.validateAnswers({ ...answers, d1: 6 }), null);
});

test("não exibe percentuais antes de cinco respostas", () => {
  const responses = Array.from({ length: 4 }, () => ({ unitId: "u1", answers }));
  const report = nr1.summarizeSurvey(responses, units);
  assert.equal(report.overall.available, false);
  assert.equal(report.units.length, 0);
});

test("suprime todos os recortes se uma unidade pequena permitir inferência por diferença", () => {
  const responses = [
    ...Array.from({ length: 5 }, () => ({ unitId: "u1", answers })),
    { unitId: "u2", answers }
  ];
  const report = nr1.summarizeSurvey(responses, units);
  assert.equal(report.overall.available, true);
  assert.equal(report.unitBreakdownSuppressed, true);
  assert.equal(report.units.length, 0);
});

test("exibe recortes quando todas as unidades respondentes têm pelo menos cinco", () => {
  const responses = ["u1", "u2"].flatMap(unitId =>
    Array.from({ length: 5 }, () => ({ unitId, answers })));
  const report = nr1.summarizeSurvey(responses, units);
  assert.equal(report.units.length, 2);
  assert.equal(report.overall.responseCount, 10);
});

test("fatores desfavoráveis respeitam a polaridade das questões", () => {
  const allHigh = Object.fromEntries(nr1.QUESTIONS.map(item => [item.id, 5]));
  const report = nr1.summarizeSurvey(Array.from({ length: 5 }, () => ({
    unitId: "u1", answers: allHigh
  })), units);
  assert.equal(report.overall.domains.demands.unfavorablePercent, 100);
  assert.equal(report.overall.domains.control.unfavorablePercent, 0);
});

test("risco exige evidência e justificativa da exposição no trabalho", () => {
  const base = { unitId: "u1", description: "Sobrecarga em turno noturno",
    workActivity: "Acolhimento", processEnvironment: "Residência assistida no turno noturno",
    affectedGroup: "Equipe de acolhimento", possibleHarm: "Esgotamento e falhas durante o trabalho",
    exposure: "Equipe insuficiente para a demanda",
    evidence: "Escalas de turno e relatos coletivos", rationale: "Exposição frequente em turnos",
    severity: 4, likelihood: 4 };
  assert.equal(nr1.validateRisk(base, units).score, 16);
  assert.equal(nr1.validateRisk({ ...base, evidence: "" }, units), null);
  assert.equal(nr1.validateRisk({ ...base, unitId: "u3" }, units), null);
});

test("ação exige prazo válido e critério de verificação", () => {
  const base = { description: "Reorganizar as escalas de atendimento", owner: "RH",
    dueDate: "2026-11-30", verification: "Comparar jornada e sobrecarga após 60 dias",
    controlType: "collective" };
  assert.ok(nr1.validateAction(base));
  assert.equal(nr1.validateAction({ ...base, dueDate: "2026-02-31" }), null);
  assert.equal(nr1.validateAction({ ...base, verification: "" }), null);
});

test("governança registra escopo, participação, privacidade e prazo da coleta", () => {
  const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const governance = nr1.validateGovernance({
    scope: "Avaliação das condições de trabalho nas duas unidades da organização.",
    workerParticipationPlan: "Todos os empregados serão convidados e participarão de devolutiva coletiva.",
    privacyContact: "privacidade@empresa.com", plannedCloseDate: future,
    retentionMonths: 60, remoteHybridCovered: false
  });
  assert.equal(governance.privacyNoticeVersion, nr1.PRIVACY_NOTICE_VERSION);
  assert.equal(nr1.validateGovernance({ ...governance, retentionMonths: 2 }), null);
});

test("integração exige responsável, AEP, destino no PGR e revisão em até dois anos", () => {
  const reviewDueDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const integration = nr1.validateIntegration({ responsibleName: "Responsável SST",
    responsibleRole: "Coordenação de SST", aepReference: "AEP-CAMPI-2026-01",
    pgrStatus: "integrated", pgrReference: "PGR-CAMPI-2026",
    integrationNotes: "Achados incorporados ao inventário e plano de ação da organização.",
    reviewDueDate, confirmResponsibility: true, criteriaAccepted: true });
  assert.ok(integration);
  assert.equal(nr1.validateIntegration({ ...integration, confirmResponsibility: false }), null);
  assert.equal(nr1.validateIntegration({ ...integration, pgrStatus: "exempt", exemptionRationale: "" }), null);
});

test("respostas ficam cifradas e vinculadas à campanha, sem texto legível no banco", () => {
  const secret = "chave-de-teste-separada-1234567890";
  const sealed = nr1.sealResponse({ unitId: "u1", answers }, secret, "campaign-a");
  assert.equal(JSON.stringify(sealed).includes('"unitId"'), false);
  assert.deepEqual(nr1.openResponse(sealed, secret, "campaign-a"), { unitId: "u1", answers });
  assert.throws(() => nr1.openResponse(sealed, secret, "campaign-b"));
  assert.throws(() => nr1.openResponse({ ...sealed, ciphertext: "AAAA" }, secret, "campaign-a"));
});
