"use strict";

const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const admin = require("firebase-admin");
const { getDb, ensureDb } = require("../services/firestore");
const { getBearerToken, verifyFirebaseToken } = require("../services/auth");
const { asyncHandler, sendError } = require("../utils");
const { EMPRESA_JWT_SECRET, THERAPY_FRONTEND_BASE } = require("../config");
const { sendEmail } = require("../services/email");
const nr1 = require("../services/nr1-workplace");

// O questionário é uma fonte exploratória de evidência, não um laudo, diagnóstico
// individual ou substituto da AEP, do inventário de riscos e do PGR da empresa.
module.exports = function createNr1Router({ verifyAdminTherapy, verificarEmpresaToken }) {
  const router = express.Router();
  const validId = value => /^[A-Za-z0-9_-]{1,100}$/.test(String(value || ""));
  for (const param of ["id", "riskId", "actionId"]) {
    router.param(param, (req, res, next, value) => validId(value)
      ? next() : sendError(res, 400, "IDENTIFICADOR_INVALIDO"));
  }
  const campaigns = () => getDb().collection("nr1_campaigns");
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const surveyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false });
  const escapeHtml = value => String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);

  async function company(req, res) {
    if (!ensureDb(res)) return null;
    if (!EMPRESA_JWT_SECRET) { sendError(res, 503, "EMPRESA_AUTH_NAO_CONFIGURADO"); return null; }
    const session = verificarEmpresaToken(getBearerToken(req));
    if (!session?.empresaId) { sendError(res, 401, "TOKEN_INVALIDO"); return null; }
    const snap = await getDb().collection("therapy_empresas").doc(session.empresaId).get();
    if (!snap.exists || snap.data().status !== "ativa") {
      sendError(res, 403, "EMPRESA_INATIVA"); return null;
    }
    if (snap.data().passwordChangedAt && session.iat < snap.data().passwordChangedAt) {
      sendError(res, 401, "TOKEN_INVALIDADO_TROCA_SENHA"); return null;
    }
    return { id: snap.id, name: snap.data().nome || "Empresa" };
  }

  async function campaignForCompany(id, companyId, res) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id || ""))) {
      sendError(res, 400, "CAMPANHA_INVALIDA"); return null;
    }
    const snap = await campaigns().doc(id).get();
    if (!snap.exists || snap.data().companyId !== companyId) {
      sendError(res, 404, "CAMPANHA_NAO_ENCONTRADA"); return null;
    }
    return snap;
  }

  function publicCampaign(snap) {
    const data = snap.data();
    return { id: snap.id, companyId: data.companyId, name: data.name,
      units: data.units, status: data.status, methodology: data.methodology,
      reviewer: data.reviewer, governance: data.governance || null,
      riskCriteria: data.riskCriteria || nr1.RISK_CRITERIA,
      integration: data.integration || null, technicalConclusion: data.technicalConclusion || null,
      openedAt: data.openedAt || null, closedAt: data.closedAt || null,
      finalizedAt: data.finalizedAt || null };
  }

  function ensureMutableCampaign(snap, res) {
    if (snap.data().status === "finalized") {
      sendError(res, 409, "CAMPANHA_FINALIZADA"); return false;
    }
    return true;
  }

  async function audit(ref, actor, type, details = {}) {
    await ref.collection("audit").add({ actor, type, details, at: stamp() });
  }

  async function employee(req, res) {
    if (!ensureDb(res)) return null;
    const uid = await verifyFirebaseToken(req, res);
    if (!uid) return null;
    const user = await admin.auth().getUser(uid);
    if (!user.emailVerified || !user.email) {
      sendError(res, 403, "EMAIL_NAO_VERIFICADO"); return null;
    }
    if (!EMPRESA_JWT_SECRET) { sendError(res, 503, "PESQUISA_NAO_CONFIGURADA"); return null; }
    const email = user.email.trim().toLowerCase();
    const lookupHash = crypto.createHmac("sha256", EMPRESA_JWT_SECRET)
      .update(`nr1-roster-v1:${email}`).digest("hex");
    const roster = await getDb().collection("nr1_participants")
      .where("lookupHash", "==", lookupHash).limit(50).get();
    const companyIds = [...new Set(roster.docs.filter(doc => doc.data().status === "active")
      .map(doc => doc.data().companyId))].filter(Boolean).filter(id => !roster.docs.some(doc =>
      doc.data().companyId === id && doc.data().status === "revoked"));
    if (!companyIds.length) {
      sendError(res, 403, "COLABORADOR_NAO_APROVADO"); return null;
    }
    const companySnaps = await Promise.all(companyIds.map(id =>
      getDb().collection("therapy_empresas").doc(id).get()));
    const activeIds = companySnaps.filter(snap => snap.exists && snap.data().status === "ativa")
      .map(snap => snap.id);
    if (!activeIds.length) { sendError(res, 403, "EMPRESA_INATIVA"); return null; }
    return { uid, companyIds: activeIds };
  }

  router.post("/therapy/admin/nr1/campaigns", asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const operator = await verifyAdminTherapy(req, res);
    if (!operator) return;
    const companyId = nr1.cleanText(req.body?.companyId, 100);
    const name = nr1.cleanText(req.body?.name, 120);
    const units = nr1.normalizeUnits(req.body?.units);
    if (!validId(companyId) || name.length < 4 || !units) return sendError(res, 400, "DADOS_INVALIDOS");
    const companySnap = await getDb().collection("therapy_empresas").doc(companyId).get();
    if (!companySnap.exists || companySnap.data().status !== "ativa") {
      return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");
    }
    const ref = campaigns().doc();
    await ref.create({ companyId, name, units, status: "draft",
      instrument: "EP-WORK-19", instrumentVersion: "1.0",
      riskCriteria: nr1.RISK_CRITERIA, createdBy: operator.email,
      createdAt: stamp(), updatedAt: stamp() });
    await audit(ref, operator.email, "campaign_created", { companyId });
    return res.status(201).json({ ok: true, id: ref.id });
  }));

  router.get("/therapy/admin/nr1/campaigns", asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const operator = await verifyAdminTherapy(req, res);
    if (!operator) return;
    const companyId = nr1.cleanText(req.query.companyId, 100);
    if (!validId(companyId)) return sendError(res, 400, "EMPRESA_OBRIGATORIA");
    const snap = await campaigns().where("companyId", "==", companyId).limit(100).get();
    return res.json({ ok: true, campaigns: snap.docs.map(publicCampaign) });
  }));

  router.patch("/therapy/admin/nr1/campaigns/:id", asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const operator = await verifyAdminTherapy(req, res);
    if (!operator) return;
    const ref = campaigns().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 404, "CAMPANHA_NAO_ENCONTRADA");
    const next = req.body?.status;
    if (next === "open" && snap.data().status === "draft") {
      if (!EMPRESA_JWT_SECRET || EMPRESA_JWT_SECRET.length < 16) {
        return sendError(res, 503, "NR1_SECRET_NAO_CONFIGURADO");
      }
      const reviewerName = nr1.cleanText(req.body?.reviewerName, 120);
      const reviewerCredential = nr1.cleanText(req.body?.reviewerCredential, 120);
      const methodology = nr1.cleanText(req.body?.methodology, 1200);
      const governance = nr1.validateGovernance(req.body?.governance);
      if (reviewerName.length < 4 || reviewerCredential.length < 4 || methodology.length < 30
          || !governance || req.body?.reviewedInstrument !== true) {
        return sendError(res, 400, "REVISAO_TECNICA_OBRIGATORIA");
      }
      await ref.update({ status: "open", reviewer: { name: reviewerName,
        credential: reviewerCredential, approvedBy: operator.email }, methodology, governance,
      openedAt: stamp(), updatedAt: stamp() });
      await audit(ref, operator.email, "survey_opened", { reviewerName, reviewerCredential });
    } else if (next === "closed" && snap.data().status === "open") {
      await ref.update({ status: "closed", closedAt: stamp(), updatedAt: stamp() });
      await audit(ref, operator.email, "survey_closed");
    } else if (next === "finalized" && snap.data().status === "closed") {
      const technicalConclusion = nr1.cleanText(req.body?.technicalConclusion, 2500);
      const reviewerName = nr1.cleanText(req.body?.reviewerName, 120);
      const reviewerCredential = nr1.cleanText(req.body?.reviewerCredential, 120);
      if (technicalConclusion.length < 30 || reviewerName.length < 4
          || reviewerCredential.length < 4 || req.body?.confirmTechnicalResponsibility !== true) {
        return sendError(res, 400, "CONCLUSAO_TECNICA_OBRIGATORIA");
      }
      const [observations, risks, actions, communications, responseDocs] = await Promise.all([
        pageCollection(ref.collection("observations")), pageCollection(ref.collection("risks")),
        pageCollection(ref.collection("actions")), pageCollection(ref.collection("communications")),
        pageCollection(ref.collection("responses"))
      ]);
      const missingUnits = snap.data().units.filter(unit =>
        !observations.some(item => item.unitId === unit.id)).map(unit => unit.name);
      const pendingReviews = risks.filter(item => item.technicalReview !== "reviewed");
      const risksWithoutAction = risks.filter(risk => risk.priority !== "baixa"
        && !actions.some(action => action.riskId === risk.id));
      const invalidEncryptedResponses = responseDocs.filter(item => {
        try { nr1.openResponse(item.sealed, EMPRESA_JWT_SECRET, snap.id); return false; }
        catch { return true; }
      }).length;
      if (missingUnits.length || pendingReviews.length || risksWithoutAction.length
          || invalidEncryptedResponses || !communications.length || !snap.data().integration) {
        return res.status(409).json({ ok: false, error: "CAMPANHA_INCOMPLETA",
          missingUnits, pendingRiskReviews: pendingReviews.map(item => item.id),
          risksWithoutAction: risksWithoutAction.map(item => item.id),
          invalidEncryptedResponses,
          missingCommunication: !communications.length,
          missingAepPgrIntegration: !snap.data().integration });
      }
      await ref.update({ status: "finalized", technicalConclusion: {
        text: technicalConclusion, reviewerName, reviewerCredential,
        confirmedBy: operator.email, criteriaVersion: nr1.RISK_CRITERIA.version
      }, finalizedAt: stamp(), updatedAt: stamp() });
      await audit(ref, operator.email, "campaign_finalized", { reviewerName, reviewerCredential });
    } else return sendError(res, 409, "TRANSICAO_INVALIDA");
    return res.json({ ok: true });
  }));

  router.get("/empresa/nr1/campaigns", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaigns().where("companyId", "==", tenant.id).limit(100).get();
    return res.json({ ok: true, campaigns: snap.docs.map(publicCampaign) });
  }));

  router.post("/empresa/nr1/participants", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const raw = req.body?.emails;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 400) {
      return sendError(res, 400, "LISTA_DE_EMAILS_INVALIDA");
    }
    const emails = [...new Set(raw.map(value => String(value || "").trim().toLowerCase()))];
    if (emails.some(email => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return sendError(res, 400, "EMAIL_INVALIDO");
    }
    const batch = getDb().batch();
    for (const email of emails) {
      const lookupHash = crypto.createHmac("sha256", EMPRESA_JWT_SECRET)
        .update(`nr1-roster-v1:${email}`).digest("hex");
      batch.set(getDb().collection("nr1_participants").doc(`${tenant.id}_${lookupHash}`), {
        companyId: tenant.id, lookupHash, status: "active", updatedAt: stamp()
      }, { merge: true });
    }
    await batch.commit();
    await getDb().collection("nr1_roster_audit").add({ companyId: tenant.id,
      action: "participants_registered", count: emails.length, at: stamp() });
    const delivery = { sent: 0, skipped: 0, failed: 0 };
    if (req.body?.sendInvites !== false) {
      const surveyUrl = `${String(THERAPY_FRONTEND_BASE).replace(/\/$/, "")}/paciente-nr1.html`;
      for (let offset = 0; offset < emails.length; offset += 10) {
        const outcomes = await Promise.all(emails.slice(offset, offset + 10).map(email => sendEmail({
          to: email,
          subject: `${tenant.name}: escuta confidencial sobre as condições de trabalho`,
          text: `A ${tenant.name} abriu uma escuta sobre as condições de trabalho com apoio do Espaço Prelúdio. Entre com este mesmo e-mail verificado e responda em ${surveyUrl}. A empresa não recebe respostas individuais. A pesquisa não é atendimento clínico.`,
          html: `<p>A <strong>${escapeHtml(tenant.name)}</strong> abriu uma escuta sobre as condições de trabalho com apoio do Espaço Prelúdio.</p><p><a href="${escapeHtml(surveyUrl)}">Acessar a pesquisa</a> usando este mesmo e-mail verificado.</p><p>A empresa não recebe respostas individuais. A pesquisa não é atendimento clínico.</p>`
        })));
        for (const result of outcomes) {
          if (result?.ok) delivery.sent++;
          else if (result?.skipped) delivery.skipped++;
          else delivery.failed++;
        }
      }
    }
    return res.status(201).json({ ok: true, count: emails.length, delivery });
  }));

  router.post("/empresa/nr1/participants/revoke", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const raw = req.body?.emails;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 400) {
      return sendError(res, 400, "LISTA_DE_EMAILS_INVALIDA");
    }
    const emails = [...new Set(raw.map(value => String(value || "").trim().toLowerCase()))];
    if (emails.some(email => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return sendError(res, 400, "EMAIL_INVALIDO");
    }
    const batch = getDb().batch();
    for (const email of emails) {
      const lookupHash = crypto.createHmac("sha256", EMPRESA_JWT_SECRET)
        .update(`nr1-roster-v1:${email}`).digest("hex");
      batch.set(getDb().collection("nr1_participants").doc(`${tenant.id}_${lookupHash}`), {
        companyId: tenant.id, lookupHash, status: "revoked", updatedAt: stamp()
      }, { merge: true });
    }
    await batch.commit();
    await getDb().collection("nr1_roster_audit").add({ companyId: tenant.id,
      action: "participants_revoked", count: emails.length, at: stamp() });
    return res.json({ ok: true, count: emails.length });
  }));

  router.get("/therapy/paciente/nr1/campaigns", asyncHandler(async (req, res) => {
    const participant = await employee(req, res);
    if (!participant) return;
    const snaps = await Promise.all(participant.companyIds.map(companyId =>
      campaigns().where("companyId", "==", companyId).limit(100).get()));
    return res.json({ ok: true, campaigns: snaps.flatMap(snap => snap.docs)
      .filter(doc => doc.data().status === "open").map(doc => ({
      id: doc.id, name: doc.data().name, units: doc.data().units,
      privacyContact: doc.data().governance?.privacyContact || null,
      privacyNoticeVersion: doc.data().governance?.privacyNoticeVersion || null,
      retentionMonths: doc.data().governance?.retentionMonths || null
    })), questions: nr1.QUESTIONS, domains: nr1.DOMAINS });
  }));

  router.post("/therapy/paciente/nr1/campaigns/:id/responses", surveyLimiter,
    asyncHandler(async (req, res) => {
      const participant = await employee(req, res);
      if (!participant) return;
      if (!EMPRESA_JWT_SECRET) return sendError(res, 503, "PESQUISA_NAO_CONFIGURADA");
      const snap = await campaigns().doc(req.params.id).get();
      if (!snap.exists || !participant.companyIds.includes(snap.data().companyId)) {
        return sendError(res, 404, "CAMPANHA_NAO_ENCONTRADA");
      }
      if (snap.data().status !== "open") return sendError(res, 409, "PESQUISA_ENCERRADA");
      const answers = nr1.validateAnswers(req.body?.answers);
      const unitId = nr1.cleanText(req.body?.unitId, 20);
      if (!answers || !snap.data().units.some(unit => unit.id === unitId)
          || req.body?.noticeAccepted !== true
          || req.body?.privacyNoticeVersion !== snap.data().governance?.privacyNoticeVersion) {
        return sendError(res, 400, "RESPOSTAS_INVALIDAS");
      }
      const responseId = crypto.createHmac("sha256", EMPRESA_JWT_SECRET)
        .update(`nr1-response-v1:${snap.id}:${participant.uid}`).digest("hex");
      try {
        await getDb().runTransaction(async tx => {
          const live = await tx.get(snap.ref);
          if (!live.exists || live.data().status !== "open") {
            const error = new Error("PESQUISA_ENCERRADA"); error.code = "NR1_CLOSED"; throw error;
          }
          const responseRef = snap.ref.collection("responses").doc(responseId);
          const existing = await tx.get(responseRef);
          if (existing.exists) {
            const error = new Error("RESPOSTA_JA_ENVIADA"); error.code = "NR1_DUPLICATE"; throw error;
          }
          tx.create(responseRef, { sealed: nr1.sealResponse({ unitId, answers,
            privacyNoticeVersion: snap.data().governance.privacyNoticeVersion,
            noticeAccepted: true }, EMPRESA_JWT_SECRET, snap.id),
            submittedAt: stamp(), instrumentVersion: "1.0" });
        });
      } catch (error) {
        if (error?.code === "NR1_CLOSED") return sendError(res, 409, "PESQUISA_ENCERRADA");
        if (error?.code === "NR1_DUPLICATE" || [6, "6", "already-exists"].includes(error?.code)) {
          return sendError(res, 409, "RESPOSTA_JA_ENVIADA");
        }
        throw error;
      }
      return res.status(201).json({ ok: true });
    }));

  async function pageCollection(ref, cap = 10000) {
    const items = [];
    let cursor = null;
    while (items.length < cap) {
      let query = ref.orderBy(admin.firestore.FieldPath.documentId()).limit(250);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      items.push(...snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      if (snap.size < 250) return items;
      cursor = snap.docs[snap.docs.length - 1];
    }
    throw new Error("NR1_REPORT_TOO_LARGE");
  }

  function aggregateEncryptedSurvey(responseDocs, campaignSnap) {
    const opened = [];
    let invalidEncryptedResponses = 0;
    for (const item of responseDocs) {
      try { opened.push(nr1.openResponse(item.sealed, EMPRESA_JWT_SECRET, campaignSnap.id)); }
      catch { invalidEncryptedResponses++; }
    }
    const summary = nr1.summarizeSurvey(opened, campaignSnap.data().units);
    summary.invalidEncryptedResponses = invalidEncryptedResponses;
    return summary;
  }

  router.get("/empresa/nr1/campaigns/:id/report", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    const [risks, actions, observations, communications, roster] = await Promise.all([
      pageCollection(snap.ref.collection("risks")),
      pageCollection(snap.ref.collection("actions")),
      pageCollection(snap.ref.collection("observations")),
      pageCollection(snap.ref.collection("communications")),
      getDb().collection("nr1_participants").where("companyId", "==", tenant.id).limit(5000).get()
    ]);
    let survey = null;
    if (["closed", "finalized"].includes(snap.data().status)) {
      const responses = await pageCollection(snap.ref.collection("responses"));
      survey = aggregateEncryptedSurvey(responses, snap);
      const eligibleParticipants = roster.docs.filter(doc => doc.data().status === "active").length;
      survey.eligibleParticipants = eligibleParticipants;
      survey.participationPercent = eligibleParticipants
        ? Math.min(100, Math.round(100 * survey.totalResponses / eligibleParticipants)) : null;
    }
    return res.json({ ok: true, company: { id: tenant.id, name: tenant.name },
      campaign: publicCampaign(snap), survey,
      risks, actions, observations, communications,
      controlHierarchy: nr1.CONTROL_HIERARCHY,
      notice: "Subsídio à AEP/PGR: a pesquisa não substitui avaliação técnica, inventário de riscos, plano de ação ou PCMSO." });
  }));

  router.get("/therapy/admin/nr1/campaigns/:id/report", asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const operator = await verifyAdminTherapy(req, res);
    if (!operator) return;
    const snap = await campaigns().doc(req.params.id).get();
    if (!snap.exists) return sendError(res, 404, "CAMPANHA_NAO_ENCONTRADA");
    const [risks, actions, observations, communications, responseDocs] = await Promise.all([
      pageCollection(snap.ref.collection("risks")),
      pageCollection(snap.ref.collection("actions")),
      pageCollection(snap.ref.collection("observations")),
      pageCollection(snap.ref.collection("communications")),
      pageCollection(snap.ref.collection("responses"))
    ]);
    const survey = ["closed", "finalized"].includes(snap.data().status)
      ? aggregateEncryptedSurvey(responseDocs, snap) : null;
    return res.json({ ok: true, campaign: publicCampaign(snap), risks, actions,
      observations, communications, responseCount: responseDocs.length, survey });
  }));

  router.post("/empresa/nr1/campaigns/:id/integration", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    if (snap.data().status !== "closed") return sendError(res, 409, "COLETA_DEVE_ESTAR_ENCERRADA");
    const integration = nr1.validateIntegration(req.body);
    if (!integration) return sendError(res, 400, "INTEGRACAO_AEP_PGR_INVALIDA");
    await snap.ref.update({ integration: { ...integration, signedByCompanyId: tenant.id,
      criteriaVersion: nr1.RISK_CRITERIA.version, signedAt: stamp() }, updatedAt: stamp() });
    await audit(snap.ref, tenant.id, "aep_pgr_integration_recorded", {
      pgrStatus: integration.pgrStatus, reviewDueDate: integration.reviewDueDate
    });
    return res.json({ ok: true });
  }));

  router.post("/empresa/nr1/campaigns/:id/communications", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    const audience = nr1.cleanText(req.body?.audience, 120);
    const channel = nr1.cleanText(req.body?.channel, 120);
    const summary = nr1.cleanText(req.body?.summary, 1500);
    if (audience.length < 3 || channel.length < 3 || summary.length < 20) {
      return sendError(res, 400, "DEVOLUTIVA_INVALIDA");
    }
    const ref = snap.ref.collection("communications").doc();
    await ref.create({ audience, channel, summary, recordedBy: tenant.id, createdAt: stamp() });
    await audit(snap.ref, tenant.id, "worker_feedback_recorded", { id: ref.id });
    return res.status(201).json({ ok: true, id: ref.id });
  }));

  router.post("/empresa/nr1/campaigns/:id/observations", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    if (!ensureMutableCampaign(snap, res)) return;
    const unitId = nr1.cleanText(req.body?.unitId, 20);
    const activity = nr1.cleanText(req.body?.activity, 500);
    const conditions = nr1.cleanText(req.body?.conditions, 1500);
    const workerParticipation = nr1.cleanText(req.body?.workerParticipation, 1000);
    if (!snap.data().units.some(unit => unit.id === unitId) || activity.length < 5
        || conditions.length < 20 || workerParticipation.length < 10) {
      return sendError(res, 400, "OBSERVACAO_INVALIDA");
    }
    const ref = snap.ref.collection("observations").doc();
    await ref.create({ unitId, activity, conditions, workerParticipation,
      recordedBy: tenant.id, createdAt: stamp() });
    await audit(snap.ref, tenant.id, "observation_created", { id: ref.id });
    return res.status(201).json({ ok: true, id: ref.id });
  }));

  router.post("/empresa/nr1/campaigns/:id/risks", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    if (!ensureMutableCampaign(snap, res)) return;
    const risk = nr1.validateRisk(req.body, snap.data().units);
    if (!risk) return sendError(res, 400, "RISCO_INVALIDO");
    const ref = snap.ref.collection("risks").doc();
    await ref.create({ ...risk, technicalReview: "pending", createdBy: tenant.id,
      createdAt: stamp() });
    await audit(snap.ref, tenant.id, "risk_created", { id: ref.id });
    return res.status(201).json({ ok: true, id: ref.id });
  }));

  router.post("/empresa/nr1/campaigns/:id/actions", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    if (!ensureMutableCampaign(snap, res)) return;
    const action = nr1.validateAction(req.body);
    const riskId = nr1.cleanText(req.body?.riskId, 100);
    if (!action || !/^[A-Za-z0-9_-]{1,100}$/.test(riskId)
        || !(await snap.ref.collection("risks").doc(riskId).get()).exists) {
      return sendError(res, 400, "ACAO_INVALIDA");
    }
    const ref = snap.ref.collection("actions").doc();
    await ref.create({ ...action, riskId, status: "planned", createdBy: tenant.id,
      createdAt: stamp(), updatedAt: stamp() });
    await audit(snap.ref, tenant.id, "action_created", { id: ref.id, riskId });
    return res.status(201).json({ ok: true, id: ref.id });
  }));

  router.patch("/empresa/nr1/campaigns/:id/actions/:actionId", asyncHandler(async (req, res) => {
    const tenant = await company(req, res);
    if (!tenant) return;
    const snap = await campaignForCompany(req.params.id, tenant.id, res);
    if (!snap) return;
    const status = req.body?.status;
    if (!["planned", "in_progress", "completed", "verified"].includes(status)) {
      return sendError(res, 400, "STATUS_INVALIDO");
    }
    const evidence = nr1.cleanText(req.body?.evidence, 1500);
    if (["completed", "verified"].includes(status) && evidence.length < 10) {
      return sendError(res, 400, "EVIDENCIA_OBRIGATORIA");
    }
    const ref = snap.ref.collection("actions").doc(req.params.actionId);
    const current = await ref.get();
    if (!current.exists) return sendError(res, 404, "ACAO_NAO_ENCONTRADA");
    const allowed = { planned: ["in_progress"], in_progress: ["completed"],
      completed: ["verified"], verified: [] };
    if (status !== current.data().status && !allowed[current.data().status]?.includes(status)) {
      return sendError(res, 409, "ETAPA_DA_ACAO_INVALIDA");
    }
    const verifiedBy = nr1.cleanText(req.body?.verifiedBy, 120);
    if (status === "verified" && verifiedBy.length < 4) {
      return sendError(res, 400, "RESPONSAVEL_PELA_VERIFICACAO_OBRIGATORIO");
    }
    await ref.update({ status, evidence, ...(status === "verified" ? { verifiedBy } : {}),
      updatedAt: stamp() });
    await audit(snap.ref, tenant.id, "action_updated", { id: ref.id, status });
    return res.json({ ok: true });
  }));

  router.patch("/therapy/admin/nr1/campaigns/:id/risks/:riskId/review", asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const operator = await verifyAdminTherapy(req, res);
    if (!operator) return;
    const snap = await campaigns().doc(req.params.id).get();
    if (!snap.exists) return sendError(res, 404, "CAMPANHA_NAO_ENCONTRADA");
    if (snap.data().status === "finalized") return sendError(res, 409, "CAMPANHA_FINALIZADA");
    const ref = snap.ref.collection("risks").doc(req.params.riskId);
    if (!(await ref.get()).exists) return sendError(res, 404, "RISCO_NAO_ENCONTRADO");
    const reviewerName = nr1.cleanText(req.body?.reviewerName, 120);
    const credential = nr1.cleanText(req.body?.credential, 120);
    const notes = nr1.cleanText(req.body?.notes, 1500);
    if (reviewerName.length < 4 || credential.length < 4 || notes.length < 10) {
      return sendError(res, 400, "REVISAO_INVALIDA");
    }
    await ref.update({ technicalReview: "reviewed", reviewerName, credential, notes,
      reviewedBy: operator.email, reviewedAt: stamp() });
    await audit(snap.ref, operator.email, "risk_reviewed", { riskId: ref.id });
    return res.json({ ok: true });
  }));

  return router;
};
