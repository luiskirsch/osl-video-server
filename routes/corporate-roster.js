"use strict";
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const firestore = require("../services/firestore");
const { sendError } = require("../utils");
const roster = require("../services/corporate-roster");
const dashboard = require("../services/corporate-dashboard");

module.exports = function createCorporateRosterRouter({ verificarEmpresaToken,
  getDb = firestore.getDb, ensureDb = firestore.ensureDb } = {}) {
  const router = express.Router();
  router.use("/empresa/colaboradores", rateLimit({ windowMs: 15 * 60 * 1000, limit: 600,
    standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "MUITAS_SOLICITACOES" } }));
  const wrap = fn => async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (!ensureDb(res)) return;
      const header = req.headers.authorization || "";
      const session = verificarEmpresaToken(header.startsWith("Bearer ") ? header.slice(7) : "");
      if (!roster.validId(session?.empresaId)) return sendError(res, 401, "TOKEN_INVALIDO");
      const db = getDb();
      const snap = await db.collection("therapy_empresas").doc(session.empresaId).get();
      if (!snap.exists || snap.data().status !== "ativa") return sendError(res, 403, "EMPRESA_INATIVA");
      const company = snap.data();
      if (company.passwordChangedAt && (!Number.isFinite(session.iat) || session.iat < company.passwordChangedAt)) return sendError(res, 401, "TOKEN_INVALIDADO_TROCA_SENHA");
      await fn(req, res, { db, id: snap.id, company, actor: company.loginEmail || `Conta da empresa · ${snap.id}` });
    } catch (error) {
      return sendError(res, error.status || 500, error.status ? error.message : "GESTAO_INDISPONIVEL", error.extra || {});
    }
  };
  const invalidate = id => dashboard.invalidateCorporateDashboard(id);
  router.get("/empresa/colaboradores", wrap(async (req, res, ctx) => {
    const all = await roster.members(ctx.db, ctx.id);
    const summary = roster.counts(all, ctx.company);
    const q = String(req.query.q || "").trim().toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const status = String(req.query.status || "all");
    if (!["all", "ativo", "pendente", "inativo", "revisar"].includes(status) || q.length > 150) roster.fail("FILTRO_INVALIDO");
    const department = String(req.query.departamento || "");
    const items = all.filter(item => (status === "all" || (status === "revisar" ? item.status === "ativo" && !item.benefitEligible : item.status === status))
      && (!department || item.departamento === department)
      && (!q || [item.nome, item.email, item.departamento, item.cargo].join(" ").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(q)))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR") || a.id.localeCompare(b.id));
    const page = Number(req.query.page || 1), limit = Number(req.query.limit || 25);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) roster.fail("PAGINACAO_INVALIDA");
    return res.json({ ok: true, items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, summary,
      departments: [...new Set(all.map(item => item.departamento).filter(Boolean))].sort(),
      company: { nome: ctx.company.nome, benefitActive: ctx.company.benefitStatus === "active" },
      registrationPath: ctx.company.slug ? `/colaborador-cadastro.html?empresa=${encodeURIComponent(ctx.company.slug)}` : null });
  }));
  router.post("/empresa/colaboradores", wrap(async (req, res, ctx) => {
    if (req.body?.status && !["ativo", "pendente"].includes(req.body.status)) roster.fail("STATUS_COLABORADOR_INVALIDO");
    const result = await roster.createMembers(ctx.db, ctx.id, ctx.actor, [req.body], { active: req.body.status === "ativo", confirmEligibility: req.body.confirmEligibility });
    invalidate(ctx.id);
    return res.status(201).json({ ok: true, item: result.items[0] });
  }));
  router.post("/empresa/colaboradores/importar/preview", wrap(async (req, res, ctx) =>
    res.json({ ok: true, ...await roster.previewImport(ctx.db, ctx.id, ctx.company, req.body?.rows) })));
  router.post("/empresa/colaboradores/importar", wrap(async (req, res, ctx) => {
    if (!roster.validId(req.body?.requestId)) roster.fail("IDENTIFICADOR_INVALIDO");
    const result = await roster.createMembers(ctx.db, ctx.id, ctx.actor, req.body?.rows, { requestId: req.body.requestId });
    invalidate(ctx.id);
    return res.status(result.replay ? 200 : 201).json({ ok: true, ...result });
  }));
  router.get("/empresa/colaboradores/movimentacoes", wrap(async (req, res, ctx) => {
    if (req.query.cursor && !roster.validId(req.query.cursor)) roster.fail("IDENTIFICADOR_INVALIDO");
    let query = ctx.db.collection(roster.EVENTS).where("empresaId", "==", ctx.id);
    query = query.orderBy("__name__");
    if (req.query.cursor) query = query.startAfter(req.query.cursor);
    const snap = await query.limit(51).get();
    const items = snap.docs.slice(0, 50).map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ ok: true, items, nextCursor: snap.docs.length > 50 ? items.at(-1).id : null });
  }));
  router.patch("/empresa/colaboradores/:id", wrap(async (req, res, ctx) => {
    const item = await roster.changeMember(ctx.db, ctx.id, ctx.actor, req.params.id, req.body);
    invalidate(ctx.id);
    return res.json({ ok: true, item });
  }));
  return router;
};
