"use strict";
const crypto = require("crypto");

// Instrumento exploratório original: percepção de condições de trabalho, não
// diagnóstico de saúde, escala clínica, HSE licenciada ou laudo de conformidade.
const DOMAINS = Object.freeze({
  demands: "Exigências e carga de trabalho",
  control: "Autonomia e organização",
  support: "Apoio e recursos",
  relationships: "Relações e respeito",
  role: "Clareza de função",
  change: "Mudanças no trabalho",
  voice: "Participação e segurança para falar"
});

const QUESTIONS = Object.freeze([
  ["d1", "demands", "A quantidade de tarefas costuma exceder o tempo disponível?", true],
  ["d2", "demands", "Os prazos de trabalho costumam ser incompatíveis com as tarefas?", true],
  ["d3", "demands", "Interrupções frequentes dificultam concluir o trabalho com segurança?", true],
  ["d4", "demands", "A equipe disponível costuma ser insuficiente para a demanda?", true],
  ["c1", "control", "Tenho margem para organizar a ordem das minhas tarefas?", false],
  ["c2", "control", "Consigo participar de decisões que afetam minha rotina de trabalho?", false],
  ["c3", "control", "Consigo fazer pausas necessárias durante o trabalho?", false],
  ["s1", "support", "Recebo orientação da liderança quando encontro dificuldades no trabalho?", false],
  ["s2", "support", "Tenho os recursos necessários para realizar minhas tarefas?", false],
  ["s3", "support", "Posso contar com apoio da equipe quando o trabalho fica difícil?", false],
  ["r1", "relationships", "Há situações de desrespeito entre pessoas no ambiente de trabalho?", true],
  ["r2", "relationships", "Há comportamentos de intimidação ou humilhação no trabalho?", true],
  ["r3", "relationships", "Os conflitos de trabalho são tratados de forma justa?", false],
  ["o1", "role", "Sei claramente quais são minhas responsabilidades no trabalho?", false],
  ["o2", "role", "Recebo orientações contraditórias sobre o que devo fazer?", true],
  ["m1", "change", "Mudanças que afetam meu trabalho são comunicadas com antecedência?", false],
  ["m2", "change", "Entendo os motivos das mudanças na forma de trabalhar?", false],
  ["v1", "voice", "Posso relatar problemas nas condições de trabalho sem receio de retaliação?", false],
  ["v2", "voice", "As sugestões dos trabalhadores sobre o trabalho são consideradas?", false]
].map(([id, domain, text, negative]) => Object.freeze({ id, domain, text, negative })));

const QUESTION_IDS = new Set(QUESTIONS.map(question => question.id));
const MIN_REPORT_RESPONSES = 5;
const PRIVACY_NOTICE_VERSION = "NR1-TRABALHO-v1";
const CONTROL_HIERARCHY = Object.freeze({
  elimination: "Eliminar o fator de risco na organização do trabalho",
  collective: "Medida coletiva ou reorganização do trabalho",
  administrative: "Medida administrativa, procedimento ou capacitação",
  individual: "Medida individual complementar"
});
const RISK_CRITERIA = Object.freeze({
  version: "EP-NR1-MATRIX-1.0",
  method: "Matriz 5 x 5 (severidade x probabilidade), aplicada por responsável tecnicamente competente",
  severity: Object.freeze({
    1: "Impacto leve, reversível e sem afastamento esperado",
    2: "Impacto menor, reversível, com necessidade de atenção",
    3: "Impacto moderado, possível afastamento ou dano relevante",
    4: "Impacto grave, afastamento prolongado ou dano importante",
    5: "Impacto crítico, incapacidade permanente, evento grave ou múltiplos atingidos"
  }),
  likelihood: Object.freeze({
    1: "Rara: exposição excepcional e controles eficazes",
    2: "Improvável: exposição ocasional e controles adequados",
    3: "Possível: exposição recorrente ou controles parcialmente eficazes",
    4: "Provável: exposição frequente e controles insuficientes",
    5: "Quase certa: exposição contínua ou ausência/falha de controles"
  }),
  levels: Object.freeze([
    Object.freeze({ min: 1, max: 4, level: "baixa", decision: "Manter controles e monitorar" }),
    Object.freeze({ min: 5, max: 9, level: "moderada", decision: "Planejar melhoria e acompanhar" }),
    Object.freeze({ min: 10, max: 16, level: "alta", decision: "Priorizar medidas e reduzir a exposição" }),
    Object.freeze({ min: 17, max: 25, level: "critica", decision: "Adotar ação imediata e controle prioritário" })
  ]),
  warning: "A matriz orienta a decisão técnica. Percentuais da pesquisa não se convertem automaticamente em nível de risco."
});

function cleanText(value, max = 500) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateGovernance(raw) {
  const scope = cleanText(raw?.scope, 1500);
  const workerParticipationPlan = cleanText(raw?.workerParticipationPlan, 1500);
  const privacyContact = cleanText(raw?.privacyContact, 200);
  const plannedCloseDate = cleanText(raw?.plannedCloseDate, 10);
  const retentionMonths = Number(raw?.retentionMonths);
  if (scope.length < 30 || workerParticipationPlan.length < 30
      || privacyContact.length < 5 || !validIsoDate(plannedCloseDate)
      || !Number.isInteger(retentionMonths) || retentionMonths < 12 || retentionMonths > 120
      || typeof raw?.remoteHybridCovered !== "boolean") return null;
  const today = new Date().toISOString().slice(0, 10);
  if (plannedCloseDate < today) return null;
  return { scope, workerParticipationPlan, privacyContact, plannedCloseDate,
    retentionMonths, remoteHybridCovered: raw.remoteHybridCovered,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION };
}

function normalizeUnits(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) return null;
  const units = raw.map((item, index) => ({
    id: `u${index + 1}`,
    name: cleanText(typeof item === "string" ? item : item?.name, 100)
  }));
  if (units.some(unit => unit.name.length < 2)) return null;
  if (new Set(units.map(unit => unit.name.toLocaleLowerCase("pt-BR"))).size !== units.length) return null;
  return units;
}

function validateAnswers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw).length !== QUESTIONS.length) return null;
  if (Object.keys(raw).some(key => !QUESTION_IDS.has(key))) return null;
  const answers = {};
  for (const question of QUESTIONS) {
    const value = Number(raw[question.id]);
    if (!Number.isInteger(value) || value < 1 || value > 5) return null;
    answers[question.id] = value;
  }
  return answers;
}

function summarizeGroup(responses) {
  if (responses.length < MIN_REPORT_RESPONSES) return { available: false };
  const domains = {};
  for (const [key, label] of Object.entries(DOMAINS)) {
    const questions = QUESTIONS.filter(item => item.domain === key);
    const total = responses.length * questions.length;
    let unfavorable = 0;
    for (const response of responses) {
      for (const question of questions) {
        const value = response.answers[question.id];
        if (question.negative ? value >= 4 : value <= 2) unfavorable++;
      }
    }
    domains[key] = { label, unfavorablePercent: Math.round(100 * unfavorable / total) };
  }
  return { available: true, responseCount: responses.length, domains };
}

function summarizeSurvey(responses, units) {
  const valid = responses.filter(item => item && validateAnswers(item.answers)
    && units.some(unit => unit.id === item.unitId));
  const overall = summarizeGroup(valid);
  const groups = units.map(unit => ({
    unitId: unit.id, unitName: unit.name,
    responses: valid.filter(item => item.unitId === unit.id)
  }));
  // Evita inferência por subtração: se uma unidade tem 1–4 respostas, nenhuma
  // unidade é divulgada, mesmo que o total geral seja >= 5.
  const canShowUnits = overall.available && groups.every(group =>
    group.responses.length === 0 || group.responses.length >= MIN_REPORT_RESPONSES);
  return {
    totalResponses: valid.length,
    overall,
    units: canShowUnits ? groups.filter(group => group.responses.length).map(group => ({
      unitId: group.unitId, unitName: group.unitName,
      ...summarizeGroup(group.responses)
    })) : [],
    unitBreakdownSuppressed: !canShowUnits
  };
}

function validateRisk(raw, units) {
  const unitId = cleanText(raw?.unitId, 20);
  const unit = units.find(item => item.id === unitId);
  const description = cleanText(raw?.description, 700);
  const workActivity = cleanText(raw?.workActivity, 500);
  const processEnvironment = cleanText(raw?.processEnvironment, 700);
  const affectedGroup = cleanText(raw?.affectedGroup, 300);
  const possibleHarm = cleanText(raw?.possibleHarm, 700);
  const exposure = cleanText(raw?.exposure, 700);
  const evidence = cleanText(raw?.evidence, 700);
  const existingControls = cleanText(raw?.existingControls, 700);
  const rationale = cleanText(raw?.rationale, 700);
  const severity = Number(raw?.severity);
  const likelihood = Number(raw?.likelihood);
  if (!unit || description.length < 10 || workActivity.length < 5
      || processEnvironment.length < 10 || affectedGroup.length < 3 || possibleHarm.length < 10
      || exposure.length < 10 || evidence.length < 10 || rationale.length < 10
      || !Number.isInteger(severity) || severity < 1 || severity > 5
      || !Number.isInteger(likelihood) || likelihood < 1 || likelihood > 5) return null;
  const score = severity * likelihood;
  return { unitId, description, workActivity, processEnvironment, affectedGroup,
    possibleHarm, exposure, evidence,
    existingControls, rationale, severity, likelihood, score,
    priority: score >= 17 ? "critica" : score >= 10 ? "alta"
      : score >= 5 ? "moderada" : "baixa" };
}

function validateAction(raw) {
  const description = cleanText(raw?.description, 700);
  const owner = cleanText(raw?.owner, 120);
  const dueDate = cleanText(raw?.dueDate, 10);
  const verification = cleanText(raw?.verification, 500);
  const controlType = cleanText(raw?.controlType, 30);
  if (description.length < 10 || owner.length < 2 || verification.length < 10
      || !validIsoDate(dueDate) || !CONTROL_HIERARCHY[controlType]) return null;
  return { description, owner, dueDate, verification, controlType };
}

function validateIntegration(raw) {
  const responsibleName = cleanText(raw?.responsibleName, 120);
  const responsibleRole = cleanText(raw?.responsibleRole, 120);
  const aepReference = cleanText(raw?.aepReference, 300);
  const pgrStatus = cleanText(raw?.pgrStatus, 20);
  const pgrReference = cleanText(raw?.pgrReference, 300);
  const exemptionRationale = cleanText(raw?.exemptionRationale, 1000);
  const integrationNotes = cleanText(raw?.integrationNotes, 1500);
  const reviewDueDate = cleanText(raw?.reviewDueDate, 10);
  if (responsibleName.length < 4 || responsibleRole.length < 3 || aepReference.length < 5
      || !["integrated", "exempt"].includes(pgrStatus) || !validIsoDate(reviewDueDate)
      || integrationNotes.length < 20 || raw?.confirmResponsibility !== true
      || raw?.criteriaAccepted !== true) return null;
  if (pgrStatus === "integrated" && pgrReference.length < 5) return null;
  if (pgrStatus === "exempt" && exemptionRationale.length < 20) return null;
  const maxReview = new Date();
  maxReview.setUTCFullYear(maxReview.getUTCFullYear() + 2);
  const today = new Date().toISOString().slice(0, 10);
  if (reviewDueDate < today
      || Date.parse(`${reviewDueDate}T12:00:00Z`) > maxReview.getTime()) return null;
  return { responsibleName, responsibleRole, aepReference, pgrStatus,
    pgrReference, exemptionRationale, integrationNotes, reviewDueDate,
    criteriaAccepted: true, confirmResponsibility: true };
}

function surveyKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error("NR1_SECRET_INVALIDO");
  return crypto.createHmac("sha256", secret).update("ep-nr1-survey-aes-gcm-v1").digest();
}

function sealResponse(response, secret, campaignId) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", surveyKey(secret), nonce);
  cipher.setAAD(Buffer.from(String(campaignId)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(response), "utf8")), cipher.final()
  ]);
  return { nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url") };
}

function openResponse(sealed, secret, campaignId) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", surveyKey(secret),
    Buffer.from(sealed.nonce, "base64url"));
  decipher.setAAD(Buffer.from(String(campaignId)));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")), decipher.final()
  ]).toString("utf8"));
}

module.exports = { DOMAINS, QUESTIONS, MIN_REPORT_RESPONSES, PRIVACY_NOTICE_VERSION,
  CONTROL_HIERARCHY, RISK_CRITERIA, cleanText, validIsoDate, validateGovernance,
  normalizeUnits, validateAnswers, summarizeSurvey, validateRisk, validateAction,
  validateIntegration, sealResponse, openResponse };
