'use strict';

// Portal do Responsavel Tecnico (RT) de Psicologia.
//
// Limite deliberado de acesso: este modulo nunca le prontuarios, notas,
// mensagens, gravacoes ou nomes de pacientes. O RT recebe apenas dados de
// habilitacao profissional, indicadores operacionais agregados e registros
// de governanca criados dentro do proprio portal.

const express = require('express');
const admin = require('firebase-admin');

const { THERAPY_ADMIN_EMAILS, THERAPY_RT_EMAILS } = require('../config');
const { getBearerToken } = require('../services/auth');
const { ensureDb, getDb } = require('../services/firestore');
const { resolveSiglaFromTherapist } = require('../services/professional-councils');
const { asyncHandler, sendError, normalizeEmail } = require('../utils');
const { logInfo } = require('../logger');

const router = express.Router();

const INCIDENT_STATUSES = new Set(['open', 'monitoring', 'resolved']);
const INCIDENT_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const INCIDENT_CATEGORIES = new Set([
  'ethics', 'privacy', 'clinical-quality', 'credential', 'accessibility', 'other'
]);
const SUPERVISION_TYPES = new Set([
  'routine', 'orientation', 'case-process', 'incident-review', 'training', 'audit'
]);

const CHECKLIST_DEFINITIONS = [
  { key: 'rt_registration', group: 'Regularidade', title: 'Cadastro da PJ e RT no CRP-MG', cadence: 'annual' },
  { key: 'professional_credentials', group: 'Profissionais', title: 'CRP e regularidade dos profissionais conferidos', cadence: 'monthly' },
  { key: 'privacy_access', group: 'Privacidade', title: 'Perfis de acesso e permissões revisados', cadence: 'monthly' },
  { key: 'clinical_records', group: 'Documentação', title: 'Rotina de registros documentais verificada', cadence: 'monthly' },
  { key: 'consent_terms', group: 'Documentação', title: 'Termos de consentimento e contratos atualizados', cadence: 'quarterly' },
  { key: 'incident_protocol', group: 'Segurança', title: 'Protocolo de incidentes testado', cadence: 'quarterly' },
  { key: 'emergency_protocol', group: 'Cuidado', title: 'Fluxo de urgência e encaminhamento revisado', cadence: 'quarterly' },
  { key: 'minor_protection', group: 'Cuidado', title: 'Fluxo para crianças e adolescentes revisado', cadence: 'quarterly' },
  { key: 'team_orientation', group: 'Supervisão', title: 'Orientação técnica periódica realizada', cadence: 'monthly' },
  { key: 'data_retention', group: 'Privacidade', title: 'Guarda e descarte seguro de dados revisados', cadence: 'annual' }
];

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanText(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function validDateOrNow(value) {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function serializeDoc(doc) {
  const data = doc.data();
  const result = { id: doc.id, ...data };
  for (const key of ['createdAt', 'updatedAt', 'occurredAt', 'supervisedAt', 'resolvedAt', 'lastReviewedAt']) {
    if (result[key]) result[key] = toMillis(result[key]);
  }
  return result;
}

function professionalIsVerified(data) {
  const status = String(data.verificationStatus || '').toLowerCase();
  return ['verified', 'approved', 'aprovado'].includes(status);
}

function councilNumber(data) {
  return cleanText(data.numeroConselho || data.crp || data.crm || '', 40);
}

function publicProfessional(doc, sessionStats = null) {
  const data = doc.data();
  const council = resolveSiglaFromTherapist(data);
  return {
    uid: doc.id,
    name: cleanText(data.displayName || data.nome || 'Profissional', 100),
    email: normalizeEmail(data.email || ''),
    council,
    councilNumber: councilNumber(data),
    verificationStatus: cleanText(data.verificationStatus || 'pending', 30),
    verified: professionalIsVerified(data),
    active: data.disabled !== true && data.status !== 'inactive',
    createdAt: toMillis(data.createdAt),
    sessions30d: sessionStats?.count || 0,
    completedSessions30d: sessionStats?.completed || 0,
    lastSessionAt: sessionStats?.lastAt || null
  };
}

async function authenticateRt(req, res) {
  if (!ensureDb(res)) return null;
  const token = getBearerToken(req);
  if (!token) {
    sendError(res, 401, 'TOKEN_NAO_INFORMADO');
    return null;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (_) {
    sendError(res, 401, 'TOKEN_INVALIDO');
    return null;
  }

  const email = normalizeEmail(decoded.email || '');
  if (!email || decoded.email_verified !== true) {
    sendError(res, 403, 'EMAIL_DO_RT_NAO_VERIFICADO');
    return null;
  }

  const isAdmin = THERAPY_ADMIN_EMAILS.includes(email);
  const isConfiguredRt = THERAPY_RT_EMAILS.includes(email);
  let assignment = null;

  if (!isAdmin && !isConfiguredRt) {
    const snap = await getDb().collection('therapy_rt_assignments')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (!snap.empty && snap.docs[0].data().active !== false) {
      assignment = serializeDoc(snap.docs[0]);
    }
  }

  if (!isAdmin && !isConfiguredRt && !assignment) {
    sendError(res, 403, 'ACESSO_RT_NAO_LIBERADO');
    return null;
  }

  return {
    uid: decoded.uid,
    email,
    name: cleanText(decoded.name || assignment?.name || 'Responsável técnico', 100),
    crp: cleanText(assignment?.crp || '', 40),
    isAdmin
  };
}

async function writeRtAudit(actor, type, details = {}) {
  try {
    await getDb().collection('therapy_rt_audit').add({
      type,
      actorUid: actor.uid,
      actorEmail: actor.email,
      ...details,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (_) { /* auditoria nao derruba a operacao principal */ }
}

async function loadOperationalData() {
  // therapy_sessions.scheduledAt e gravado como epoch em milissegundos.
  // Consultar com Timestamp excluiria silenciosamente todas as sessoes.
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const db = getDb();
  const [professionalsSnap, sessionsSnap, incidentsSnap, supervisionsSnap] = await Promise.all([
    db.collection('therapists').limit(1000).get(),
    db.collection('therapy_sessions').where('scheduledAt', '>=', since).limit(5000).get(),
    db.collection('therapy_rt_incidents').limit(500).get(),
    db.collection('therapy_rt_supervisions').limit(500).get()
  ]);

  const psychologyDocs = professionalsSnap.docs.filter(doc => resolveSiglaFromTherapist(doc.data()) === 'CRP');
  const psychologyUids = new Set(psychologyDocs.map(doc => doc.id));
  const stats = new Map();
  const sessionStatuses = {};

  for (const doc of sessionsSnap.docs) {
    const data = doc.data();
    if (!psychologyUids.has(data.therapistUid)) continue;
    const current = stats.get(data.therapistUid) || { count: 0, completed: 0, lastAt: null };
    current.count += 1;
    if (data.status === 'completed') current.completed += 1;
    const at = toMillis(data.scheduledAt);
    if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
    stats.set(data.therapistUid, current);
    const status = cleanText(data.status || 'unknown', 30);
    sessionStatuses[status] = (sessionStatuses[status] || 0) + 1;
  }

  const professionals = psychologyDocs
    .map(doc => publicProfessional(doc, stats.get(doc.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const incidents = incidentsSnap.docs.map(serializeDoc).sort((a, b) => (b.occurredAt || b.createdAt || 0) - (a.occurredAt || a.createdAt || 0));
  const supervisions = supervisionsSnap.docs.map(serializeDoc).sort((a, b) => (b.supervisedAt || b.createdAt || 0) - (a.supervisedAt || a.createdAt || 0));

  return { professionals, incidents, supervisions, sessionStatuses };
}

router.get('/rt/me', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  return res.json({ ok: true, actor });
}));

router.get('/rt/dashboard', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const data = await loadOperationalData();
  const completed = Object.entries(data.sessionStatuses)
    .filter(([status]) => ['completed', 'finished', 'done'].includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const totalSessions = Object.values(data.sessionStatuses).reduce((sum, count) => sum + count, 0);
  return res.json({
    ok: true,
    generatedAt: Date.now(),
    metrics: {
      professionals: data.professionals.length,
      verifiedProfessionals: data.professionals.filter(p => p.verified && p.councilNumber).length,
      sessions30d: totalSessions,
      completedSessions30d: completed,
      openIncidents: data.incidents.filter(i => i.status !== 'resolved').length,
      criticalIncidents: data.incidents.filter(i => i.status !== 'resolved' && i.severity === 'critical').length,
      supervisions30d: data.supervisions.filter(s => (s.supervisedAt || s.createdAt || 0) >= Date.now() - 30 * 86400000).length
    },
    attention: data.professionals.filter(p => !p.verified || !p.councilNumber).slice(0, 12),
    recentIncidents: data.incidents.slice(0, 8),
    recentSupervisions: data.supervisions.slice(0, 8),
    sessionStatuses: data.sessionStatuses
  });
}));

router.get('/rt/profissionais', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const data = await loadOperationalData();
  return res.json({ ok: true, professionals: data.professionals });
}));

router.get('/rt/incidentes', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const snap = await getDb().collection('therapy_rt_incidents').limit(500).get();
  const incidents = snap.docs.map(serializeDoc).sort((a, b) => (b.occurredAt || b.createdAt || 0) - (a.occurredAt || a.createdAt || 0));
  return res.json({ ok: true, incidents });
}));

router.post('/rt/incidentes', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const title = cleanText(req.body?.title, 140);
  const description = cleanText(req.body?.description, 2000);
  const severity = cleanText(req.body?.severity, 20).toLowerCase();
  const category = cleanText(req.body?.category, 40).toLowerCase();
  if (!title || !description) return sendError(res, 400, 'TITULO_E_DESCRICAO_OBRIGATORIOS');
  if (!INCIDENT_SEVERITIES.has(severity)) return sendError(res, 400, 'GRAVIDADE_INVALIDA');
  if (!INCIDENT_CATEGORIES.has(category)) return sendError(res, 400, 'CATEGORIA_INVALIDA');
  const occurredAt = validDateOrNow(req.body?.occurredAt);
  if (!occurredAt) return sendError(res, 400, 'DATA_INVALIDA');

  const ref = await getDb().collection('therapy_rt_incidents').add({
    title, description, severity, category, status: 'open',
    occurredAt,
    createdByUid: actor.uid,
    createdByName: actor.name,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await writeRtAudit(actor, 'incident_created', { incidentId: ref.id, severity, category });
  logInfo('rt_incident_created', { incidentId: ref.id, severity, category });
  return res.status(201).json({ ok: true, id: ref.id });
}));

router.patch('/rt/incidentes/:id', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const id = cleanText(req.params.id, 120);
  const status = cleanText(req.body?.status, 20).toLowerCase();
  if (!INCIDENT_STATUSES.has(status)) return sendError(res, 400, 'STATUS_INVALIDO');
  const resolution = cleanText(req.body?.resolution, 2000);
  const incidentRef = getDb().collection('therapy_rt_incidents').doc(id);
  const incidentSnap = await incidentRef.get();
  if (!incidentSnap.exists) return sendError(res, 404, 'INCIDENTE_NAO_ENCONTRADO');
  const update = {
    status,
    resolution,
    updatedByUid: actor.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (status === 'resolved') update.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
  await incidentRef.set(update, { merge: true });
  await writeRtAudit(actor, 'incident_updated', { incidentId: id, status });
  return res.json({ ok: true, id, status });
}));

router.get('/rt/supervisoes', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const snap = await getDb().collection('therapy_rt_supervisions').limit(500).get();
  const supervisions = snap.docs.map(serializeDoc).sort((a, b) => (b.supervisedAt || b.createdAt || 0) - (a.supervisedAt || a.createdAt || 0));
  return res.json({ ok: true, supervisions });
}));

router.post('/rt/supervisoes', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const type = cleanText(req.body?.type, 30).toLowerCase();
  const title = cleanText(req.body?.title, 140);
  const summary = cleanText(req.body?.summary, 3000);
  const actions = Array.isArray(req.body?.actions)
    ? req.body.actions.map(item => cleanText(item, 300)).filter(Boolean).slice(0, 20)
    : [];
  const participantCount = Math.max(0, Math.min(500, Number(req.body?.participantCount) || 0));
  const durationMinutes = Math.max(1, Math.min(1440, Number(req.body?.durationMinutes) || 60));
  if (!SUPERVISION_TYPES.has(type)) return sendError(res, 400, 'TIPO_INVALIDO');
  if (!title || !summary) return sendError(res, 400, 'TITULO_E_RESUMO_OBRIGATORIOS');
  const supervisedAt = validDateOrNow(req.body?.supervisedAt);
  if (!supervisedAt) return sendError(res, 400, 'DATA_INVALIDA');

  const ref = await getDb().collection('therapy_rt_supervisions').add({
    type, title, summary, actions, participantCount, durationMinutes,
    supervisedAt,
    rtUid: actor.uid,
    rtName: actor.name,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await writeRtAudit(actor, 'supervision_created', { supervisionId: ref.id, type });
  logInfo('rt_supervision_created', { supervisionId: ref.id, type });
  return res.status(201).json({ ok: true, id: ref.id });
}));

router.get('/rt/checklist', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const snap = await getDb().collection('therapy_rt_compliance').doc('main').get();
  const saved = snap.exists ? snap.data().items || {} : {};
  const items = CHECKLIST_DEFINITIONS.map(item => ({
    ...item,
    status: cleanText(saved[item.key]?.status || 'pending', 20),
    note: cleanText(saved[item.key]?.note || '', 1000),
    lastReviewedAt: toMillis(saved[item.key]?.lastReviewedAt),
    reviewedByName: cleanText(saved[item.key]?.reviewedByName || '', 100)
  }));
  return res.json({ ok: true, items });
}));

router.patch('/rt/checklist/:key', asyncHandler(async (req, res) => {
  const actor = await authenticateRt(req, res);
  if (!actor) return;
  const key = cleanText(req.params.key, 80);
  if (!CHECKLIST_DEFINITIONS.some(item => item.key === key)) return sendError(res, 404, 'ITEM_NAO_ENCONTRADO');
  const status = cleanText(req.body?.status, 20).toLowerCase();
  if (!['pending', 'review', 'compliant'].includes(status)) return sendError(res, 400, 'STATUS_INVALIDO');
  const note = cleanText(req.body?.note, 1000);
  await getDb().collection('therapy_rt_compliance').doc('main').set({
    items: {
      [key]: {
        status, note,
        reviewedByUid: actor.uid,
        reviewedByName: actor.name,
        lastReviewedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await writeRtAudit(actor, 'checklist_updated', { checklistKey: key, status });
  return res.json({ ok: true, key, status });
}));

module.exports = router;
