"use strict";

const crypto = require("node:crypto");
const { normalizeEmploymentType } = require("./corporate-eligibility");
const { companyDocuments } = require("./corporate-dashboard");

const MEMBERS = "therapy_colaboradores";
const EVENTS = "therapy_corporate_roster_events";
const REASONS = ["demissao", "pedido_colaborador", "fim_contrato", "outro"];
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function fail(message, status = 400, extra = {}) { throw Object.assign(new Error(message), { status, extra }); }
function today(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
function date(value, required = false) {
  if (!value && !required) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value
    || value < "1900-01-01" || value > today()) fail("DATA_INVALIDA");
  return value;
}
function text(value, maximum, required = false) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || value.trim().length > maximum) fail("CAMPO_INVALIDO");
  const result = value.trim();
  if (required && result.length < 2) fail("NOME_OBRIGATORIO");
  return result || null;
}
function fields(input, creating = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("DADOS_INVALIDOS");
  const out = {};
  for (const [key, max] of Object.entries({ nome: 150, telefone: 30, departamento: 100, cargo: 100 })) {
    if (creating || Object.hasOwn(input, key)) out[key] = text(input[key], max, key === "nome");
  }
  if (creating) {
    if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) fail("EMAIL_INVALIDO");
    out.email = input.email.trim().toLowerCase();
  }
  if (creating || Object.hasOwn(input, "employmentType")) {
    out.employmentType = normalizeEmploymentType(input.employmentType);
    if (input.employmentType && !out.employmentType) fail("TIPO_VINCULO_INVALIDO");
  }
  if (creating || Object.hasOwn(input, "admissionDate")) out.admissionDate = date(input.admissionDate);
  return out;
}
const millis = v => Number(v?.toMillis?.() ?? v) || 0;
function publicMember(id, data) {
  return { id, nome: data.nome || "", email: data.email || "", telefone: data.telefone || "",
    departamento: data.departamento || "", cargo: data.cargo || "", employmentType: data.employmentType || null,
    status: ["ativo", "pendente", "inativo"].includes(data.status) ? data.status : "pendente",
    benefitEligible: data.status === "ativo" && !!data.eligibilityVerifiedAt && data.benefitEligible !== false,
    admissionDate: data.admissionDate || null, departureDate: data.departureDate || null,
    departureReason: REASONS.includes(data.departureReason) ? data.departureReason : null,
    createdAt: millis(data.createdAt), version: millis(data.updatedAt) };
}
async function members(db, companyId) {
  const result = [];
  for await (const doc of companyDocuments(db.collection(MEMBERS), companyId,
    ["nome", "email", "telefone", "departamento", "cargo", "employmentType", "status", "benefitEligible", "eligibilityVerifiedAt", "admissionDate", "departureDate", "departureReason", "createdAt", "updatedAt"])) {
    result.push(publicMember(doc.id, doc.data()));
  }
  return result;
}
function counts(items, company) {
  const summary = { total: items.length, ativo: 0, pendente: 0, inativo: 0, elegiveis: 0 };
  for (const item of items) { summary[item.status]++; if (item.benefitEligible) summary.elegiveis++; }
  summary.ocupadas = summary.ativo + summary.pendente;
  summary.limite = Number(company.limiteColaboradores) > 0 ? Number(company.limiteColaboradores) : null;
  summary.disponiveis = summary.limite === null ? null : Math.max(0, summary.limite - summary.ocupadas);
  return summary;
}
function event(db, tx, companyId, actor, type, memberId, before, after, now) {
  const ref = db.collection(EVENTS).doc(`${String(9999999999999 - now).padStart(13, "0")}_${crypto.randomUUID()}`);
  tx.create(ref, { empresaId: companyId, memberId, type, nome: after.nome, email: after.email,
    actor: actor || "Conta da empresa", createdAt: now, before: before ? publicMember(memberId, before) : null,
    after: publicMember(memberId, after) });
}
function assertCompany(snap) {
  if (!snap.exists || snap.data().status !== "ativa") fail("EMPRESA_INATIVA", 403);
  return snap.data();
}
function assertCapacity(docs, company, extra) {
  const occupied = docs.filter(doc => doc.data().status !== "inativo").length;
  if (extra > 0 && Number(company.limiteColaboradores) > 0 && occupied + extra > Number(company.limiteColaboradores)) fail("LIMITE_COLABORADORES_ATINGIDO", 409);
}
async function createMembers(db, companyId, actor, inputRows, options = {}) {
  if (!Array.isArray(inputRows) || !inputRows.length || inputRows.length > 100) fail("IMPORTACAO_LIMITE_100");
  const rows = inputRows.map(row => fields(row, true));
  if (new Set(rows.map(row => row.email)).size !== rows.length) fail("EMAIL_REPETIDO_PLANILHA", 409);
  const active = options.active === true;
  if (active && (options.confirmEligibility !== true || rows.some(row => !row.employmentType))) fail("CONFIRME_VINCULO_E_TIPO");
  const requestId = options.requestId;
  if (requestId !== undefined && !validId(requestId)) fail("IDENTIFICADOR_INVALIDO");
  const importRef = requestId ? db.collection("therapy_corporate_roster_imports").doc(`${companyId}_${requestId}`) : null;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ rows, active })).digest("hex");
  const now = Date.now();
  const companyRef = db.collection("therapy_empresas").doc(companyId);
  const refs = rows.map(row => db.collection(MEMBERS).doc(crypto.createHash("sha256").update(`${companyId}:${row.email}`).digest("hex")));
  return db.runTransaction(async tx => {
    const company = assertCompany(await tx.get(companyRef));
    if (importRef) {
      const previous = await tx.get(importRef);
      if (previous.exists) {
        if (previous.data().fingerprint !== fingerprint) fail("IMPORTACAO_DIVERGENTE", 409);
        return { items: previous.data().items, replay: true };
      }
    }
    const current = await tx.get(db.collection(MEMBERS).where("empresaId", "==", companyId));
    const existing = new Set(current.docs.map(doc => String(doc.data().email || "").toLowerCase()));
    if (rows.some(row => existing.has(row.email))) fail("EMAIL_JA_CADASTRADO", 409);
    // Also read deterministic references before any write. Company document serializes
    // seat changes and query phantom protection covers old random-ID registrations.
    for (const ref of refs) if ((await tx.get(ref)).exists) fail("EMAIL_JA_CADASTRADO", 409);
    assertCapacity(current.docs, company, rows.length);
    if (active && company.benefitStatus !== "active") fail("BENEFICIO_INATIVO", 409);
    const items = rows.map((row, i) => {
      const data = { ...row, empresaId: companyId, empresaNome: company.nome || "", empresaSlug: company.slug || "",
        status: active ? "ativo" : "pendente", benefitEligible: active, nr1Scope: "technical_review",
        eligibilityVerifiedAt: active ? now : null, eligibilityVerifiedBy: active ? actor : null,
        createdAt: now, updatedAt: now, departureDate: null, departureReason: null, origem: "empresa-rh",
        ...(options.metadata || {}) };
      tx.create(refs[i], data);
      event(db, tx, companyId, actor, active ? "admissao" : "cadastro", refs[i].id, null, data, now);
      return publicMember(refs[i].id, data);
    });
    tx.update(companyRef, { totalColaboradores: current.docs.length + rows.length, rosterUpdatedAt: now });
    if (importRef) tx.create(importRef, { empresaId: companyId, fingerprint, items, createdAt: now });
    return { items, replay: false };
  });
}
async function previewImport(db, companyId, company, inputRows) {
  if (!Array.isArray(inputRows) || !inputRows.length || inputRows.length > 100) fail("IMPORTACAO_LIMITE_100");
  const existing = await members(db, companyId);
  const emails = new Set(existing.map(row => row.email.toLowerCase()));
  const seen = new Set();
  const rows = inputRows.map((input, i) => {
    try {
      const row = fields(input, true);
      if (emails.has(row.email)) fail("EMAIL_JA_CADASTRADO");
      if (seen.has(row.email)) fail("EMAIL_REPETIDO_PLANILHA");
      seen.add(row.email);
      return { line: i + 2, item: row, error: null };
    } catch (error) { return { line: i + 2, item: { nome: String(input?.nome || "").slice(0, 150), email: String(input?.email || "").slice(0, 254) }, error: error.message }; }
  });
  const summary = counts(existing, company);
  const capacityExceeded = summary.disponiveis !== null && inputRows.length > summary.disponiveis;
  return { rows, valid: rows.every(row => !row.error) && !capacityExceeded, capacityExceeded, summary };
}
async function changeMember(db, companyId, actor, id, input) {
  if (!validId(id) || !input || !Number.isSafeInteger(input.version) || input.version < 0) fail("VERSAO_OBRIGATORIA");
  const action = input.action || "update";
  if (!["update", "approve", "deactivate", "reactivate"].includes(action)) fail("ACAO_INVALIDA");
  const changes = fields(input);
  const companyRef = db.collection("therapy_empresas").doc(companyId);
  const ref = db.collection(MEMBERS).doc(id);
  return db.runTransaction(async tx => {
    const company = assertCompany(await tx.get(companyRef));
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().empresaId !== companyId) fail("COLABORADOR_NAO_ENCONTRADO", 404);
    const before = snap.data();
    if (millis(before.updatedAt) !== input.version) fail("CADASTRO_ALTERADO_RECARREGUE", 409);
    const now = Math.max(Date.now(), millis(before.updatedAt) + 1);
    const after = { ...before, ...changes, updatedAt: now };
    if (action === "approve" || action === "reactivate") {
      if (before.status === "inativo" && action !== "reactivate") fail("USE_REATIVACAO", 409);
      if (before.status !== "inativo" && action === "reactivate") fail("COLABORADOR_NAO_INATIVO", 409);
      if (before.status === "ativo" && before.eligibilityVerifiedAt && before.benefitEligible !== false) fail("COLABORADOR_JA_ATIVO", 409);
      if (!after.employmentType || input.confirmEligibility !== true) fail("CONFIRME_VINCULO_E_TIPO");
      if (company.benefitStatus !== "active") fail("BENEFICIO_INATIVO", 409);
      if (action === "reactivate") {
        const current = await tx.get(db.collection(MEMBERS).where("empresaId", "==", companyId));
        assertCapacity(current.docs, company, 1);
      }
      Object.assign(after, { status: "ativo", benefitEligible: true, eligibilityVerifiedAt: now,
        eligibilityVerifiedBy: actor, departureDate: null, departureReason: null });
    }
    if (action === "deactivate") {
      if (before.status === "inativo") fail("COLABORADOR_JA_INATIVO", 409);
      if (input.confirmDeactivation !== true || !REASONS.includes(input.departureReason)) fail("CONFIRME_DESLIGAMENTO");
      const departureDate = date(input.departureDate, true);
      if (after.admissionDate && departureDate < after.admissionDate) fail("DESLIGAMENTO_ANTERIOR_ADMISSAO");
      Object.assign(after, { status: "inativo", benefitEligible: false, eligibilityVerifiedAt: null,
        eligibilityVerifiedBy: null, departureDate, departureReason: input.departureReason });
    }
    if (after.status === "ativo" && after.eligibilityVerifiedAt && after.benefitEligible !== false
        && !normalizeEmploymentType(after.employmentType)) fail("TIPO_VINCULO_OBRIGATORIO");
    // Generic updates cannot alter status, account UID, scope, company or clinical fields.
    tx.set(ref, after);
    tx.update(companyRef, { rosterUpdatedAt: now });
    const types = { update: "edicao", approve: "aprovacao", deactivate: "desligamento", reactivate: "readmissao" };
    event(db, tx, companyId, actor, types[action], id, before, after, now);
    return publicMember(id, after);
  });
}
module.exports = { MEMBERS, EVENTS, REASONS, validId, fail, today, fields, publicMember, members, counts, createMembers, previewImport, changeMember };
