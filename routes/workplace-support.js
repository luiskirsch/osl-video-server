"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const admin = require("firebase-admin");
const firestore = require("../services/firestore");
const auth = require("../services/auth");
const { EMPRESA_JWT_SECRET } = require("../config");
const { sendError } = require("../utils");
const support = require("../services/workplace-support");

module.exports = function createWorkplaceSupportRouter({ verifyAdminTherapy, verificarEmpresaToken,
  getDb = firestore.getDb, ensureDb = firestore.ensureDb, verifyFirebaseToken = auth.verifyFirebaseToken,
  getUser = uid => admin.auth().getUser(uid), secret = EMPRESA_JWT_SECRET } = {}) {
  const router = express.Router();
  const collection = () => getDb().collection(support.COLLECTION);
  const configRef = id => getDb().collection(support.CONFIG_COLLECTION).doc(id);
  const companyRef = id => getDb().collection("therapy_empresas").doc(id);
  const actions = () => getDb().collection(support.ACTION_COLLECTION);
  const wrap = fn => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!ensureDb(res)) return;
      support.keyFor(secret).fill(0);
      await fn(req, res);
    } catch (error) {
      // Never forward user-authored material or decrypted records to loggers.
      return sendError(res, error.status || 500, error.status ? error.message : "APOIO_INDISPONIVEL");
    }
  };
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true,
    legacyHeaders: false, message: { ok: false, error: "MUITAS_SOLICITACOES" } });
  const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true,
    legacyHeaders: false, skip: req => ["GET", "HEAD", "OPTIONS"].includes(req.method),
    message: { ok: false, error: "MUITAS_SOLICITACOES" } });
  for (const base of ["/therapy/paciente/apoio", "/therapy/admin/apoio", "/empresa/apoio"]) router.use(base, limiter, writeLimiter);
  for (const name of ["id", "actionId"]) router.param(name, (req, res, next, id) => support.validId(id)
    ? next() : sendError(res, 400, "IDENTIFICADOR_INVALIDO"));
  const eligible = (data, uid) => data.status === "ativo" && data.eligibilityVerifiedAt
    && data.benefitEligible !== false && (!data.patientAccountUid || data.patientAccountUid === uid);
  async function employee(req, res, linked = false) {
    const uid = await verifyFirebaseToken(req, res, { checkRevoked: true });
    if (!uid) return null;
    const user = await getUser(uid);
    if (!user.emailVerified || !user.email || user.disabled) { sendError(res, 403, "EMAIL_NAO_VERIFICADO"); return null; }
    const actor = { uid, role: "employee", key: support.ownerKey(uid), name: user.displayName || "Colaborador", email: user.email.trim().toLowerCase(), companies: [] };
    if (!linked) return actor; // Existing requests remain available after unlinking.
    const roster = await getDb().collection("therapy_colaboradores").where("email", "==", actor.email).limit(51).get();
    if (roster.docs.length > 50) support.fail("LIMITE_DE_VINCULOS", 409);
    const members = roster.docs.filter(doc => eligible(doc.data(), uid) && support.validId(doc.data().empresaId));
    const ids = [...new Set(members.map(doc => doc.data().empresaId))];
    for (const id of ids) {
      const snap = await companyRef(id).get();
      if (snap.exists && snap.data().status === "ativa") actor.companies.push({ id, name: snap.data().nome || "Empresa",
        memberRef: members.find(doc => doc.data().empresaId === id).ref });
    }
    return actor;
  }
  async function company(req, res) {
    const session = verificarEmpresaToken(auth.getBearerToken(req));
    if (!support.validId(session?.empresaId)) { sendError(res, 401, "TOKEN_INVALIDO"); return null; }
    const snap = await companyRef(session.empresaId).get();
    if (!snap.exists || snap.data().status !== "ativa") { sendError(res, 403, "EMPRESA_INATIVA"); return null; }
    if (snap.data().passwordChangedAt && (!Number.isFinite(session.iat) || session.iat < snap.data().passwordChangedAt)) {
      sendError(res, 401, "TOKEN_INVALIDADO_TROCA_SENHA"); return null;
    }
    return { role: "company", companyId: snap.id };
  }
  async function operator(req, res) {
    const actor = await verifyAdminTherapy(req, res);
    return actor ? { role: "care" } : null;
  }
  function authorized(actor, record) {
    return actor.role === "employee" ? record.ownerKey === actor.key
      : actor.role === "company" ? record.recipient === "company" && record.companyId === actor.companyId
      : record.recipient === "care";
  }
  function readItem(actor, snap) {
    if (!snap.exists || !authorized(actor, snap.data())) support.fail("PEDIDO_NAO_ENCONTRADO", 404);
    return support.open(snap.id, snap.data(), secret);
  }
  async function getConfig(id) {
    const snap = await configRef(id).get();
    return { ...support.DEFAULT_CONFIG, ...(snap.exists ? snap.data().config : {}) };
  }
  function page(req) {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (req.query.cursor && !support.validId(req.query.cursor))) support.fail("PAGINACAO_INVALIDA");
    return { limit, cursor: req.query.cursor || null };
  }
  async function listPage(query, req) {
    const paging = page(req);
    query = query.orderBy(admin.firestore.FieldPath.documentId());
    if (paging.cursor) query = query.startAfter(paging.cursor);
    const snap = await query.limit(paging.limit + 1).get();
    const docs = snap.docs.slice(0, paging.limit);
    return { docs, nextCursor: snap.docs.length > paging.limit ? docs[docs.length - 1].id : null };
  }
  async function publicActions(companyId) {
    const snap = await actions().where("companyId", "==", companyId).limit(501).get();
    if (snap.docs.length > 500) support.fail("LIMITE_DE_ACOES", 409);
    return snap.docs.map(doc => ({ ...doc.data(), id: doc.id })).sort((a, b) => b.createdAt - a.createdAt);
  }

  router.get("/therapy/paciente/apoio/context", wrap(async (req, res) => {
    const actor = await employee(req, res, true);
    if (!actor) return;
    const companies = await Promise.all(actor.companies.map(async ({ id, name }) => ({ id, name, config: await getConfig(id) })));
    res.json({ ok: true, companies, categories: support.CATEGORIES });
  }));
  router.get("/therapy/paciente/apoio/actions", wrap(async (req, res) => {
    const actor = await employee(req, res, true);
    if (!actor) return;
    if (!actor.companies.some(c => c.id === req.query.companyId)) return sendError(res, 403, "VINCULO_OBRIGATORIO");
    res.json({ ok: true, items: await publicActions(req.query.companyId) });
  }));
  router.post("/therapy/paciente/apoio/requests", wrap(async (req, res) => {
    const actor = await employee(req, res, true);
    if (!actor) return;
    const input = support.normalizeRequest(req.body);
    const id = support.requestKey(actor.uid, req.body.requestId);
    const ref = collection().doc(id);
    const result = await getDb().runTransaction(async tx => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        const item = readItem(actor, existing);
        if (item.requestFingerprint !== support.fingerprint(input)) support.fail("IDENTIFICADOR_REUTILIZADO", 409);
        return { item, created: false };
      }
      const membership = actor.companies.find(c => c.id === input.companyId);
      if (!membership) support.fail("VINCULO_OBRIGATORIO", 403);
      const [freshMember, freshCompany, configSnap] = await Promise.all([
        tx.get(membership.memberRef), tx.get(companyRef(input.companyId)), tx.get(configRef(input.companyId))
      ]);
      if (!freshMember.exists || !eligible(freshMember.data(), actor.uid) || freshMember.data().empresaId !== input.companyId
        || freshMember.data().email !== actor.email || !freshCompany.exists || freshCompany.data().status !== "ativa") support.fail("VINCULO_OBRIGATORIO", 403);
      const config = { ...support.DEFAULT_CONFIG, ...(configSnap.exists ? configSnap.data().config : {}) };
      const item = support.createItem(actor.uid, id, input, config, actor);
      tx.create(ref, support.seal(item, secret));
      return { item, created: true };
    });
    res.status(result.created ? 201 : 200).json({ ok: true, item: support.view(result.item) });
  }));

  for (const [base, authenticate] of [["/therapy/paciente/apoio", employee], ["/empresa/apoio", company], ["/therapy/admin/apoio", operator]]) {
    router.get(`${base}/requests`, wrap(async (req, res) => {
      const actor = await authenticate(req, res);
      if (!actor) return;
      let query = actor.role === "employee" ? collection().where("ownerKey", "==", actor.key)
        : actor.role === "company" ? collection().where("companyInboxKey", "==", actor.companyId)
        : collection().where("recipient", "==", "care");
      if (actor.role === "care" && req.query.companyId) {
        if (!support.validId(req.query.companyId)) support.fail("EMPRESA_INVALIDA");
        query = collection().where("careInboxKey", "==", req.query.companyId);
      }
      const { docs, nextCursor } = await listPage(query, req);
      const items = docs.filter(doc => authorized(actor, doc.data())).map(doc => support.view(readItem(actor, doc)));
      res.json({ ok: true, items, nextCursor });
    }));
    router.get(`${base}/requests/:id`, wrap(async (req, res) => {
      const actor = await authenticate(req, res);
      if (!actor) return;
      res.json({ ok: true, item: support.view(readItem(actor, await collection().doc(req.params.id).get())) });
    }));
    const operations = base.includes("paciente") ? [["messages", "message"], ["feedback", "feedback"], ["cancel", "cancel"]]
      : [["messages", "message"], ["", "update"]];
    for (const [suffix, operation] of operations) {
      router[operation === "update" ? "patch" : "post"](`${base}/requests/:id${suffix ? `/${suffix}` : ""}`, wrap(async (req, res) => {
        const actor = await authenticate(req, res);
        if (!actor) return;
        const ref = collection().doc(req.params.id);
        const item = await getDb().runTransaction(async tx => {
          const current = readItem(actor, await tx.get(ref));
          const next = support.mutate(current, actor.role, operation, req.body);
          tx.set(ref, support.seal(next, secret));
          return next;
        });
        res.json({ ok: true, item: support.view(item) });
      }));
    }
  }
  async function saveConfig(req, res, id, isAdmin) {
    const ref = configRef(id);
    const config = await getDb().runTransaction(async tx => {
      const [tenant, snap] = await Promise.all([tx.get(companyRef(id)), tx.get(ref)]);
      if (!tenant.exists || tenant.data().status !== "ativa") support.fail("EMPRESA_INATIVA", 403);
      const next = support.normalizeConfig(req.body, snap.exists ? snap.data().config : undefined, isAdmin);
      tx.set(ref, { config: next, updatedAt: Date.now(), updatedBy: isAdmin ? "care" : "company" });
      return next;
    });
    res.json({ ok: true, config });
  }
  router.get("/empresa/apoio/config", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (actor) res.json({ ok: true, config: await getConfig(actor.companyId) });
  }));
  router.put("/empresa/apoio/config", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (actor) await saveConfig(req, res, actor.companyId, false);
  }));
  router.get("/therapy/admin/apoio/companies", wrap(async (req, res) => {
    if (!await operator(req, res)) return;
    const { docs, nextCursor } = await listPage(getDb().collection("therapy_empresas").where("status", "==", "ativa"), req);
    const items = await Promise.all(docs.map(async doc => ({ id: doc.id, name: doc.data().nome || "Empresa", config: await getConfig(doc.id) })));
    res.json({ ok: true, items, companies: items, nextCursor });
  }));
  router.put("/therapy/admin/apoio/companies/:id/config", wrap(async (req, res) => {
    if (await operator(req, res)) await saveConfig(req, res, req.params.id, true);
  }));
  router.get("/empresa/apoio/summary", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (!actor) return;
    const period = support.closedPeriod();
    const ref = getDb().collection(support.SUMMARY_COLLECTION).doc(`${actor.companyId}_${period.period}`);
    let snapshot = await ref.get();
    if (!snapshot.exists) {
      const records = await collection().where("companyId", "==", actor.companyId).limit(5001).get();
      if (records.docs.length > 5000) support.fail("RELATORIO_REQUER_PROCESSAMENTO", 409);
      const items = records.docs.filter(doc => doc.data().createdAt >= period.start && doc.data().createdAt < period.end)
        .map(doc => support.open(doc.id, doc.data(), secret));
      const summary = support.aggregate(items, period);
      await getDb().runTransaction(async tx => {
        if (!(await tx.get(ref)).exists) tx.create(ref, { ...summary, generatedAt: Date.now() });
      });
      snapshot = await ref.get();
    }
    res.json({ ok: true, summary: snapshot.data(), ...snapshot.data() });
  }));
  router.get("/empresa/apoio/actions", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (actor) res.json({ ok: true, items: await publicActions(actor.companyId) });
  }));
  router.post("/empresa/apoio/actions", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (!actor) return;
    const normalized = support.normalizeAction(req.body || {});
    const ref = actions().doc();
    const now = Date.now();
    const item = { ...normalized, id: ref.id, companyId: actor.companyId, version: 1, createdAt: now, updatedAt: now };
    await ref.create(item);
    res.status(201).json({ ok: true, item });
  }));
  router.patch("/empresa/apoio/actions/:actionId", wrap(async (req, res) => {
    const actor = await company(req, res);
    if (!actor) return;
    const ref = actions().doc(req.params.actionId);
    const item = await getDb().runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().companyId !== actor.companyId) support.fail("ACAO_NAO_ENCONTRADA", 404);
      if (req.body?.version !== snap.data().version) support.fail("VERSAO_DESATUALIZADA", 409);
      const next = { ...support.normalizeAction(req.body, snap.data()), version: snap.data().version + 1, updatedAt: Date.now() };
      tx.set(ref, next);
      return next;
    });
    res.json({ ok: true, item });
  }));
  return router;
};
