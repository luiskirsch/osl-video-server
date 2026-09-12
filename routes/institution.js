'use strict';

// Portal institucional para escolas e redes de ensino.
// Expõe somente indicadores operacionais agregados. Dados identificáveis,
// prontuários, conversas e conteúdo clínico nunca fazem parte da resposta.

const express = require('express');
const admin = require('firebase-admin');

const { verifyFirebaseToken } = require('../services/auth');
const { ensureDb, getDb } = require('../services/firestore');
const { asyncHandler, sendError, normalizeEmail } = require('../utils');

const router = express.Router();

const ACTIVE_CASE_STATUSES = new Set(['assigned', 'care_active']);
const PENDING_CASE_STATUSES = new Set([
  'pending_guardian_consent',
  'pending_participant_consent',
  'pending_triage',
  'triage_in_progress',
  'waiting_assignment'
]);
const OPEN_SESSION_STATUSES = new Set(['scheduled', 'waiting', 'active', 'in_progress']);
const MINIMUM_AGGREGATE_SIZE = 5;

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function serializeProgram(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    name: String(data.name || 'Programa institucional'),
    contractingAuthorityName: String(data.contractingAuthorityName || ''),
    municipality: String(data.municipality || ''),
    state: String(data.state || ''),
    contractNumber: String(data.contractNumber || ''),
    startDate: data.startDate || null,
    endDate: data.endDate || null,
    status: String(data.status || 'draft'),
    registrationOpen: data.registrationOpen === true,
    maxStudents: safeNumber(data.maxStudents),
    maxMonthlySessions: safeNumber(data.maxMonthlySessions),
    maxSessionsPerStudent: safeNumber(data.maxSessionsPerStudent),
    updatedAt: toMillis(data.updatedAt)
  };
}

function serializeSchool(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    programId: String(data.programId || ''),
    name: String(data.name || 'Unidade'),
    network: String(data.network || ''),
    educationStages: Array.isArray(data.educationStages) ? data.educationStages.slice(0, 12) : [],
    city: String(data.addressCity || ''),
    state: String(data.addressState || ''),
    status: String(data.status || 'inactive'),
    maxStudents: safeNumber(data.maxStudents),
    updatedAt: toMillis(data.updatedAt)
  };
}

async function getInstitutionActor(req, res) {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return null;

  let user;
  try {
    user = await admin.auth().getUser(uid);
  } catch {
    sendError(res, 401, 'CONTA_NAO_ENCONTRADA');
    return null;
  }

  if (user.emailVerified !== true) {
    sendError(res, 403, 'EMAIL_INSTITUCIONAL_NAO_VERIFICADO');
    return null;
  }

  const email = normalizeEmail(user.email);
  if (!email) {
    sendError(res, 403, 'EMAIL_INSTITUCIONAL_OBRIGATORIO');
    return null;
  }

  const db = getDb();
  const [programsSnap, schoolsSnap] = await Promise.all([
    db.collection('therapy_public_programs').where('publicManagerEmail', '==', email).limit(100).get(),
    db.collection('therapy_schools').where('coordinatorEmail', '==', email).limit(500).get()
  ]);

  const managedPrograms = programsSnap.docs.map(serializeProgram);
  const coordinatedSchools = schoolsSnap.docs.map(serializeSchool);

  if (!managedPrograms.length && !coordinatedSchools.length) {
    sendError(res, 403, 'ACESSO_INSTITUCIONAL_NAO_LIBERADO');
    return null;
  }

  return {
    uid,
    email,
    name: String(user.displayName || managedPrograms[0]?.name || coordinatedSchools[0]?.name || 'Gestão institucional'),
    managedPrograms,
    coordinatedSchools
  };
}

function emptyUnitMetrics() {
  return {
    students: 0,
    activeCare: 0,
    pending: 0,
    completedCases: 0,
    scheduledSessions: 0,
    completedSessions: 0
  };
}

function addMetrics(target, metrics) {
  target.students += metrics.students;
  target.activeCare += metrics.activeCare;
  target.pending += metrics.pending;
  target.completedCases += metrics.completedCases;
  target.scheduledSessions += metrics.scheduledSessions;
  target.completedSessions += metrics.completedSessions;
}

function protectSmallAggregate(metrics) {
  const protectedByThreshold = metrics.students > 0 && metrics.students < MINIMUM_AGGREGATE_SIZE;
  if (!protectedByThreshold) return { ...metrics, protectedByThreshold: false };
  return {
    ...metrics,
    activeCare: null,
    pending: null,
    completedCases: null,
    scheduledSessions: null,
    completedSessions: null,
    protectedByThreshold: true
  };
}

async function buildProgramOverview(program, allowedSchoolIds = null, database = null) {
  const db = database || getDb();
  const [schoolsSnap, studentsSnap, casesSnap, sessionsSnap] = await Promise.all([
    db.collection('therapy_schools').where('programId', '==', program.id).limit(1000).get(),
    db.collection('therapy_estudantes').where('programId', '==', program.id).limit(5000).get(),
    db.collection('therapy_student_cases').where('programId', '==', program.id).limit(5000).get(),
    db.collection('therapy_sessions').where('publicProgramId', '==', program.id).limit(5000).get()
  ]);

  const schools = schoolsSnap.docs
    .map(serializeSchool)
    .filter(school => !allowedSchoolIds || allowedSchoolIds.has(school.id));
  const metricsBySchool = new Map(schools.map(school => [school.id, emptyUnitMetrics()]));

  for (const doc of studentsSnap.docs) {
    const data = doc.data();
    const metrics = metricsBySchool.get(String(data.schoolId || ''));
    if (metrics) metrics.students += 1;
  }

  for (const doc of casesSnap.docs) {
    const data = doc.data();
    const metrics = metricsBySchool.get(String(data.schoolId || ''));
    if (!metrics) continue;
    const status = String(data.status || '');
    if (ACTIVE_CASE_STATUSES.has(status)) metrics.activeCare += 1;
    if (PENDING_CASE_STATUSES.has(status)) metrics.pending += 1;
    if (status === 'discharged') metrics.completedCases += 1;
  }

  for (const doc of sessionsSnap.docs) {
    const data = doc.data();
    const metrics = metricsBySchool.get(String(data.publicSchoolId || data.schoolId || ''));
    if (!metrics) continue;
    const status = String(data.status || '');
    if (status === 'completed') metrics.completedSessions += 1;
    if (OPEN_SESSION_STATUSES.has(status)) {
      metrics.scheduledSessions += 1;
    }
  }

  const totals = emptyUnitMetrics();
  const units = schools
    .map(school => {
      const metrics = metricsBySchool.get(school.id) || emptyUnitMetrics();
      addMetrics(totals, metrics);
      return { ...school, metrics: protectSmallAggregate(metrics) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return {
    ...program,
    totals: {
      ...protectSmallAggregate(totals),
      schools: units.length,
      activeSchools: units.filter(unit => unit.status === 'active').length
    },
    units
  };
}

// GET /institution/overview
// Gestor do programa vê todas as unidades; coordenador vê somente a sua.
router.get('/institution/overview', asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  const actor = await getInstitutionActor(req, res);
  if (!actor) return;

  const programMap = new Map(actor.managedPrograms.map(program => [program.id, program]));
  const managerProgramIds = new Set(programMap.keys());

  const missingProgramIds = [...new Set(
    actor.coordinatedSchools
      .map(school => school.programId)
      .filter(programId => programId && !programMap.has(programId))
  )];

  if (missingProgramIds.length) {
    const docs = await Promise.all(
      missingProgramIds.map(programId => getDb().collection('therapy_public_programs').doc(programId).get())
    );
    for (const doc of docs) {
      if (doc.exists) programMap.set(doc.id, serializeProgram(doc));
    }
  }

  const coordinatedByProgram = new Map();
  for (const school of actor.coordinatedSchools) {
    if (!coordinatedByProgram.has(school.programId)) coordinatedByProgram.set(school.programId, new Set());
    coordinatedByProgram.get(school.programId).add(school.id);
  }

  const programs = await Promise.all([...programMap.values()].map(program => {
    const allowedSchoolIds = managerProgramIds.has(program.id)
      ? null
      : (coordinatedByProgram.get(program.id) || new Set());
    return buildProgramOverview(program, allowedSchoolIds);
  }));

  return res.json({
    ok: true,
    actor: {
      name: actor.name,
      email: actor.email,
      scope: managerProgramIds.size ? 'program_manager' : 'school_coordinator'
    },
    programs,
    privacy: {
      aggregatedOnly: true,
      clinicalContentAvailable: false,
      identifiableStudentDataAvailable: false,
      minimumAggregateSize: MINIMUM_AGGREGATE_SIZE
    },
    updatedAt: Date.now()
  });
}));

router._test = {
  buildProgramOverview,
  protectSmallAggregate,
  serializeProgram,
  serializeSchool
};

module.exports = router;
