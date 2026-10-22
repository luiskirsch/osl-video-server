"use strict";

const crypto = require("node:crypto");
const { encryptJson, decryptJson } = require("./clinical-encryption");
const CATEGORIES = Object.freeze([
  { id: "overload", label: "Minha rotina ficou impossível" },
  { id: "leadership", label: "Preciso de apoio para uma conversa no trabalho" },
  { id: "personal", label: "Uma situação pessoal está afetando minha rotina" }
]);
const DEFAULT_CONFIG = Object.freeze({ enabled: false, careEnabled: false, companyEnabled: false,
  careOwnerName: "", companyOwnerName: "", responseHours: 48, contact: "" });
const STATUSES = ["open", "in_progress", "waiting_employee", "resolved", "closed", "cancelled"];
const COLLECTION = "therapy_workplace_support";
const CONFIG_COLLECTION = "therapy_workplace_support_config";
const ACTION_COLLECTION = "therapy_workplace_support_actions";
const SUMMARY_COLLECTION = "therapy_workplace_support_summaries";
function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function text(value, max, min = 0) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("TEXTO_INVALIDO");
  const result = value.trim();
  if (result.length < min) fail("TEXTO_INVALIDO");
  return result;
}
function ownerKey(uid) { return crypto.createHash("sha256").update(`workplace-support:${uid}`).digest("hex"); }
function requestKey(uid, requestId) { return crypto.createHash("sha256").update(`${ownerKey(uid)}:${requestId}`).digest("hex"); }
function keyFor(secret) {
  if (typeof secret !== "string" || secret.length < 16) fail("APOIO_INDISPONIVEL", 503);
  return Buffer.from(crypto.hkdfSync("sha256", secret, "ep-workplace-support", "v1", 32));
}
function seal(item, secret) {
  const key = keyFor(secret);
  try {
    return { ownerKey: item.ownerKey, companyId: item.companyId, recipient: item.recipient,
      companyInboxKey: item.recipient === "company" ? item.companyId : "",
      careInboxKey: item.recipient === "care" ? item.companyId : "", createdAt: item.createdAt,
      payload: encryptJson(item, key) };
  } finally { key.fill(0); }
}
function open(id, record, secret) {
  const key = keyFor(secret);
  try {
    const item = decryptJson(record.payload, key);
    if (item.id !== id || item.ownerKey !== record.ownerKey || item.companyId !== record.companyId
      || item.recipient !== record.recipient || item.createdAt !== record.createdAt
      || record.companyInboxKey !== (item.recipient === "company" ? item.companyId : "")
      || record.careInboxKey !== (item.recipient === "care" ? item.companyId : "")) fail("REGISTRO_CIFRADO_INVALIDO", 500);
    return item;
  } finally { key.fill(0); }
}
function view(item) { const { ownerKey: _owner, requestFingerprint: _fingerprint, ...safe } = item; return safe; }
function normalizeRequest(input) {
  if (!input || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId || "")) fail("IDENTIFICADOR_INVALIDO");
  if (!validId(input.companyId) || !CATEGORIES.some(c => c.id === input.category)
    || !["care", "company"].includes(input.recipient)) fail("DADOS_INVALIDOS");
  if (input.consent !== true || typeof input.aggregateConsent !== "boolean") fail("CONSENTIMENTO_OBRIGATORIO");
  return { companyId: input.companyId, category: input.category, recipient: input.recipient,
    text: text(input.text, 6000, 10), need: input.need === undefined ? "" : text(input.need, 1000), consent: true,
    aggregateConsent: input.aggregateConsent };
}
function fingerprint(normalized) { return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex"); }
function normalizeConfig(input, previous = DEFAULT_CONFIG, isAdmin = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("CONFIGURACAO_INVALIDA");
  const result = { ...DEFAULT_CONFIG, ...previous };
  for (const name of ["enabled", "companyEnabled", "careEnabled"]) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== "boolean") fail("CONFIGURACAO_INVALIDA");
    if (name === "careEnabled" && !isAdmin && input[name] !== result[name]) fail("ACOLHIMENTO_CONFIGURADO_PELA_EQUIPE", 403);
    result[name] = input[name];
  }
  for (const name of ["careOwnerName", "companyOwnerName", "contact"]) {
    if (input[name] === undefined) continue;
    const value = text(input[name], name === "contact" ? 250 : 120);
    if (name === "careOwnerName" && !isAdmin && value !== result[name]) fail("ACOLHIMENTO_CONFIGURADO_PELA_EQUIPE", 403);
    result[name] = value;
  }
  if (input.responseHours !== undefined) {
    if (!Number.isInteger(input.responseHours) || input.responseHours < 1 || input.responseHours > 168) fail("PRAZO_INVALIDO");
    result.responseHours = input.responseHours;
  }
  if (result.enabled && ((!result.careEnabled && !result.companyEnabled)
    || (result.careEnabled && !result.careOwnerName) || (result.companyEnabled && !result.companyOwnerName))) fail("RESPONSAVEL_OBRIGATORIO");
  if (result.enabled && !result.contact) fail("CONTATO_OBRIGATORIO");
  return result;
}
function createItem(uid, id, input, config, identity, now = Date.now()) {
  if (!config.enabled || !config[`${input.recipient}Enabled`]) fail("CAMINHO_INDISPONIVEL", 409);
  return { ...input, id, ownerKey: ownerKey(uid), requestFingerprint: fingerprint(input),
    employeeName: identity.name || "Colaborador", employeeEmail: identity.email,
    status: "open", version: 1, createdAt: now, updatedAt: now, dueAt: now + config.responseHours * 3600000,
    responseHours: config.responseHours, ownerName: config[`${input.recipient}OwnerName`],
    nextStep: "A equipe responsável vai ler seu pedido e responder por aqui.",
    messages: [], events: [{ type: "created", at: now, actor: "employee" }], feedback: null };
}
function mutate(item, actor, operation, body, now = Date.now()) {
  if (!Number.isSafeInteger(body?.version) || body.version !== item.version) fail("VERSAO_DESATUALIZADA", 409);
  if (item.events.length >= 400 || item.messages.length >= 200) fail("LIMITE_DO_ACOMPANHAMENTO", 409);
  const next = { ...item, messages: [...item.messages], events: [...item.events] };
  const terminal = ["closed", "cancelled"].includes(item.status);
  if (terminal) fail("PEDIDO_ENCERRADO", 409);
  if (operation === "message") {
    next.messages.push({ id: crypto.randomUUID(), actor, text: text(body.text, 3000, 1), at: now });
    if (actor !== "employee" && !item.firstResponseAt) next.firstResponseAt = now;
    if (actor === "employee" && item.status === "waiting_employee") next.status = "in_progress";
    if (actor !== "employee" && item.status === "open") next.status = "in_progress";
  } else if (operation === "feedback" && actor === "employee") {
    if (!["helped", "need_support", "continues"].includes(body.outcome)) fail("RETORNO_INVALIDO");
    next.feedback = { outcome: body.outcome, text: body.text ? text(body.text, 2000) : "", at: now };
    next.status = body.outcome === "helped" ? "closed" : "in_progress";
    if (body.outcome !== "helped") {
      next.nextStep = "A equipe responsável recebeu seu retorno e vai continuar o acompanhamento.";
      next.dueAt = now + item.responseHours * 3600000;
    }
  } else if (operation === "cancel" && actor === "employee") {
    next.status = "cancelled";
  } else if (operation === "update" && actor !== "employee") {
    // Resaving the current stage is a no-op; a team update takes over an open request.
    if (body.status !== undefined && body.status !== item.status) {
      if (!["in_progress", "waiting_employee", "resolved"].includes(body.status)) fail("ESTADO_INVALIDO");
      next.status = body.status;
    }
    if (next.status === "open") next.status = "in_progress";
    for (const name of ["ownerName", "nextStep"]) if (body[name] !== undefined) next[name] = text(body[name], name === "ownerName" ? 120 : 1000, 3);
    if (body.dueAt !== undefined) {
      const due = typeof body.dueAt === "number" ? body.dueAt : Date.parse(body.dueAt);
      if (!Number.isSafeInteger(due) || due < now || due > now + 90 * 86400000) fail("PRAZO_INVALIDO");
      next.dueAt = due;
    }
    if (next.status === "resolved" && item.status !== "resolved" && !body.nextStep) fail("PROXIMO_PASSO_OBRIGATORIO");
  } else fail("OPERACAO_INVALIDA", 403);
  next.version += 1;
  next.updatedAt = now;
  next.events.push({ type: operation, actor, at: now, status: next.status,
    ...(operation === "feedback" ? { outcome: body.outcome } : {}) });
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > 600000) fail("LIMITE_DO_ACOMPANHAMENTO", 409);
  return next;
}
function closedPeriod(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find(p => p.type === "year").value);
  const month = Number(parts.find(p => p.type === "month").value);
  const end = Date.UTC(year, month - 1, 1, 3);
  const start = Date.UTC(year, month - 2, 1, 3);
  return { period: new Date(start).toISOString().slice(0, 7), start, end };
}
function aggregate(items, period) {
  const cohort = items.filter(i => i.aggregateConsent === true && i.createdAt >= period.start && i.createdAt < period.end);
  const people = new Set(cohort.map(i => i.ownerKey));
  const base = { period: period.period, threshold: 10, frozen: true,
    note: "Indicadores de pedidos voluntários do mês encerrado; não representam toda a empresa. Grupos pequenos são protegidos." };
  const carePeople = new Set(cohort.filter(i => i.recipient === "care").map(i => i.ownerKey));
  if (people.size < 10 || (carePeople.size > 0 && carePeople.size < 10)) return { ...base, suppressed: true, categories: [], total: null, people: null };
  const categories = CATEGORIES.map(c => {
    const subset = cohort.filter(i => i.category === c.id);
    return { id: c.id, label: c.label, count: subset.length, people: new Set(subset.map(i => i.ownerKey)).size };
  });
  // Entire breakdown suppressed if any nonempty category is small: the total
  // cannot then be used to subtract and reconstruct a protected category.
  const protectedCareGroup = subset => {
    const size = new Set(subset.filter(i => i.recipient === "care").map(i => i.ownerKey)).size;
    return size === 0 || size >= 10;
  };
  const showCategories = categories.every(c => (c.people === 0 || c.people >= 10)
    && protectedCareGroup(cohort.filter(i => i.category === c.id)));
  const responses = cohort.filter(i => i.firstResponseAt && i.firstResponseAt < period.end);
  const helped = cohort.filter(i => i.feedback?.outcome === "helped" && i.feedback.at < period.end);
  const showOutcomes = new Set(helped.map(i => i.ownerKey)).size >= 10
    && new Set(cohort.filter(i => !helped.includes(i)).map(i => i.ownerKey)).size >= 10
    && protectedCareGroup(helped) && protectedCareGroup(cohort.filter(i => !helped.includes(i)));
  return { ...base, suppressed: false, total: cohort.length, people: people.size,
    categories: showCategories ? categories.map(({ people: _people, ...c }) => c) : [], categoriesSuppressed: !showCategories,
    // Response averages and outcomes are themselves protected cohorts.
    averageResponseHours: new Set(responses.map(i => i.ownerKey)).size >= 10
      && (responses.length === cohort.length || new Set(cohort.filter(i => !responses.includes(i)).map(i => i.ownerKey)).size >= 10)
      && protectedCareGroup(responses) && protectedCareGroup(cohort.filter(i => !responses.includes(i)))
      ? Math.round(responses.reduce((sum, i) => sum + (i.firstResponseAt - i.createdAt) / 3600000, 0) / responses.length) : null,
    helped: showOutcomes ? helped.length : null };
}
function normalizeAction(input, previous = {}) {
  const result = { ...previous };
  for (const name of ["title", "ownerName", "description"]) {
    if (input[name] !== undefined) result[name] = text(input[name], name === "description" ? 2000 : 160, name === "description" ? 0 : 3);
  }
  if (!result.title || !result.ownerName) fail("ACAO_INVALIDA");
  if (input.status !== undefined) result.status = input.status;
  if (!["planned", "in_progress", "done"].includes(result.status || "planned")) fail("ESTADO_INVALIDO");
  result.status ||= "planned";
  result.description ||= "";
  if (input.dueDate !== undefined) result.dueDate = input.dueDate;
  if (typeof result.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(result.dueDate)
    || !Number.isFinite(Date.parse(result.dueDate)) || new Date(result.dueDate).toISOString().slice(0, 10) !== result.dueDate) fail("PRAZO_INVALIDO");
  return result;
}
async function deleteForAccount(db, uid) {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(COLLECTION).where("ownerKey", "==", ownerKey(uid)).limit(400).get();
    if (!snap.docs.length) break;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.docs.length;
  }
  return deleted;
}
module.exports = { CATEGORIES, DEFAULT_CONFIG, STATUSES, COLLECTION, CONFIG_COLLECTION, ACTION_COLLECTION,
  SUMMARY_COLLECTION, fail, validId, text, ownerKey, requestKey, keyFor, seal, open, view, normalizeRequest,
  fingerprint, normalizeConfig, createItem, mutate, closedPeriod, aggregate, normalizeAction, deleteForAccount };
