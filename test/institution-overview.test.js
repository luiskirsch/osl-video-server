'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const institutionRouter = require('../routes/institution');
const { buildProgramOverview, protectSmallAggregate } = institutionRouter._test;

function firestoreDoc(id, data) {
  return { id, data: () => data };
}

function fakeDatabase(seed) {
  return {
    collection(name) {
      const source = seed[name] || [];
      let filtered = source;
      return {
        where(field, operator, expected) {
          assert.equal(operator, '==');
          filtered = filtered.filter(doc => doc.data()[field] === expected);
          return this;
        },
        limit() { return this; },
        async get() { return { docs: filtered }; }
      };
    }
  };
}

const program = {
  id: 'program-1',
  name: 'Programa municipal',
  maxStudents: 450,
  status: 'active'
};

const database = fakeDatabase({
  therapy_schools: [
    firestoreDoc('school-a', { programId: 'program-1', name: 'Escola Aurora', status: 'active' }),
    firestoreDoc('school-b', { programId: 'program-1', name: 'Escola Horizonte', status: 'active' })
  ],
  therapy_estudantes: [
    firestoreDoc('student-a', { programId: 'program-1', schoolId: 'school-a', nome: 'Dado identificável A' }),
    ...Array.from({ length: 4 }, (_, index) => firestoreDoc(`student-a-${index}`, { programId: 'program-1', schoolId: 'school-a' })),
    firestoreDoc('student-b', { programId: 'program-1', schoolId: 'school-b', nome: 'Dado identificável B' }),
    ...Array.from({ length: 4 }, (_, index) => firestoreDoc(`student-b-${index}`, { programId: 'program-1', schoolId: 'school-b' }))
  ],
  therapy_student_cases: [
    firestoreDoc('case-a', { programId: 'program-1', schoolId: 'school-a', status: 'care_active', clinicalNotes: 'sigiloso' }),
    firestoreDoc('case-b', { programId: 'program-1', schoolId: 'school-b', status: 'pending_triage', clinicalNotes: 'sigiloso' })
  ],
  therapy_sessions: [
    firestoreDoc('session-a', { publicProgramId: 'program-1', publicSchoolId: 'school-a', status: 'completed', patientName: 'Sigiloso' }),
    firestoreDoc('session-b', { publicProgramId: 'program-1', publicSchoolId: 'school-b', status: 'completed', patientName: 'Sigiloso' })
  ]
});

test('gestor do programa recebe indicadores agregados de todas as unidades', async () => {
  const overview = await buildProgramOverview(program, null, database);

  assert.deepEqual(overview.units.map(unit => unit.id), ['school-a', 'school-b']);
  assert.equal(overview.totals.schools, 2);
  assert.equal(overview.totals.students, 10);
  assert.equal(overview.totals.activeCare, 1);
  assert.equal(overview.totals.pending, 1);
  assert.equal(overview.totals.completedSessions, 2);

  const serialized = JSON.stringify(overview);
  assert.doesNotMatch(serialized, /Dado identificável|clinicalNotes|sigiloso|patientName/i);
});

test('coordenador recebe somente a unidade vinculada à sua conta', async () => {
  const overview = await buildProgramOverview(program, new Set(['school-a']), database);

  assert.deepEqual(overview.units.map(unit => unit.id), ['school-a']);
  assert.equal(overview.totals.schools, 1);
  assert.equal(overview.totals.students, 5);
  assert.equal(overview.totals.activeCare, 1);
  assert.equal(overview.totals.pending, 0);
  assert.equal(overview.totals.completedSessions, 1);
});

test('indicadores de uso são ocultados quando a amostra tem menos de cinco participantes', () => {
  assert.deepEqual(protectSmallAggregate({
    students: 1,
    activeCare: 1,
    pending: 0,
    completedCases: 0,
    scheduledSessions: 1,
    completedSessions: 3
  }), {
    students: 1,
    activeCare: null,
    pending: null,
    completedCases: null,
    scheduledSessions: null,
    completedSessions: null,
    protectedByThreshold: true
  });
});
