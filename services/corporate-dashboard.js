"use strict";

const PAGE_SIZE = 250;
const MIN_COHORT = 5;
const REPORT_TIME_ZONE = "America/Sao_Paulo";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_COMPANIES = 100;
const dashboardCache = new Map();

// Firestore limits `in` queries to 30 values. Reading by the authoritative
// empresaId instead also avoids matching a session to an unverified email.
async function* companyDocuments(collection, empresaId, fields = []) {
  let last = null;
  while (true) {
    let query = collection.where("empresaId", "==", empresaId)
      .orderBy("__name__")
      .limit(PAGE_SIZE);
    // Projection avoids transferring names, emails, notes or clinical records
    // into the analytics process when only a few aggregate fields are needed.
    if (fields.length) query = query.select(...fields);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    const docs = snapshot.docs || [];
    for (const doc of docs) yield doc;
    if (docs.length < PAGE_SIZE) return;
    last = docs[docs.length - 1];
  }
}

function localDateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== "literal")
    .map(part => [part.type, Number(part.value)]));
}

function midnightInTimeZone(year, month, timeZone) {
  const wallUtc = Date.UTC(year, month - 1, 1);
  let instant = wallUtc;
  // Re-evaluate the offset at the target instant, so daylight-saving changes
  // around a month boundary cannot shift the reporting period.
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localDateParts(instant, timeZone);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const adjusted = instant + wallUtc - localAsUtc;
    if (adjusted === instant) break;
    instant = adjusted;
  }
  return instant;
}

function calendarMonthBounds(now = Date.now(), timeZone = REPORT_TIME_ZONE) {
  const date = localDateParts(now, timeZone);
  const first = midnightInTimeZone(date.year, date.month, timeZone);
  const nextYear = date.month === 12 ? date.year + 1 : date.year;
  const nextMonth = date.month === 12 ? 1 : date.month + 1;
  return {
    start: first,
    end: midnightInTimeZone(nextYear, nextMonth, timeZone),
    period: `${date.year}-${String(date.month).padStart(2, "0")}`,
    timeZone
  };
}

function sessionTime(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return NaN;
}

function visibleCount(count, distinctCount, cohortSize) {
  if (cohortSize < MIN_COHORT) return null;
  return distinctCount === 0 || distinctCount >= MIN_COHORT ? count : null;
}

async function buildCorporateDashboard(db, empresaId, empresa, now = Date.now()) {
  const month = calendarMonthBounds(now);
  const activeIds = new Set();
  let totalCadastrados = 0;
  for await (const doc of companyDocuments(db.collection("therapy_colaboradores"), empresaId, ["status"])) {
    totalCadastrados++;
    if (doc.data().status === "ativo") activeIds.add(doc.id);
  }

  let sessoesTotal = 0;
  let sessoesMes = 0;
  let incomplete = false;
  const allPatients = new Set();
  const monthPatients = new Set();
  const activeMonthPatients = new Set();
  const specialties = new Map();

  for await (const doc of companyDocuments(db.collection("therapy_sessions"), empresaId,
    ["status", "colaboradorId", "scheduledAt", "therapistEspecialidade", "especialidade"])) {
    const session = doc.data();
    if (session.status !== "completed") continue;
    const collaboratorId = String(session.colaboradorId || "");
    const scheduledAt = sessionTime(session.scheduledAt);
    // Old email-based links or unscheduled sessions are not silently included
    // as confirmed corporate care. A migration is required before publishing.
    if (!collaboratorId || !Number.isFinite(scheduledAt) || scheduledAt <= 0) {
      incomplete = true;
      continue;
    }

    sessoesTotal++;
    allPatients.add(collaboratorId);
    if (scheduledAt < month.start || scheduledAt >= month.end) continue;

    sessoesMes++;
    monthPatients.add(collaboratorId);
    if (activeIds.has(collaboratorId)) activeMonthPatients.add(collaboratorId);
    const specialty = String(session.therapistEspecialidade || session.especialidade || "Outros")
      .trim().slice(0, 80) || "Outros";
    if (!specialties.has(specialty)) specialties.set(specialty, { count: 0, patients: new Set() });
    const entry = specialties.get(specialty);
    entry.count++;
    entry.patients.add(collaboratorId);
  }

  const cohortSize = activeIds.size;
  const publicTotal = incomplete ? null : visibleCount(sessoesTotal, allPatients.size, cohortSize);
  const publicMonth = incomplete ? null : visibleCount(sessoesMes, monthPatients.size, cohortSize);
  const visibleAdherence = !incomplete && cohortSize >= MIN_COHORT &&
    (activeMonthPatients.size === 0 || activeMonthPatients.size >= MIN_COHORT);

  // Do not publish one small specialty next to a total from which its size
  // could be inferred by subtraction. Show the breakdown only as a whole.
  const specialtiesSafe = !incomplete && cohortSize >= MIN_COHORT &&
    [...specialties.values()].every(entry => entry.patients.size >= MIN_COHORT);
  const especialidades = specialtiesSafe
    ? Object.fromEntries([...specialties].map(([name, entry]) => [name, entry.count]))
    : {};

  const mascarado = cohortSize < MIN_COHORT || incomplete || publicTotal === null ||
    publicMonth === null || !visibleAdherence || !specialtiesSafe;
  return {
    ok: true,
    empresa: { nome: empresa.nome, segmento: empresa.segmento || null },
    kpis: {
      totalCadastrados: cohortSize < MIN_COHORT ? null : totalCadastrados,
      totalAtivos: cohortSize < MIN_COHORT ? null : cohortSize,
      sessoesMes: mascarado ? null : publicMonth,
      sessoesTotal: mascarado ? null : publicTotal,
      taxaAdesao: visibleAdherence
        && !mascarado ? Math.round(activeMonthPatients.size / cohortSize * 100)
        : null
    },
    especialidades: mascarado ? {} : especialidades,
    mascarado,
    dadosIncompletos: incomplete,
    periodo: month.period,
    fusoHorario: month.timeZone,
    geradoEm: now
  };
}

function getCachedCorporateDashboard(db, empresaId, empresa) {
  const now = Date.now();
  const cached = dashboardCache.get(empresaId);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = buildCorporateDashboard(db, empresaId, empresa, now);
  dashboardCache.delete(empresaId);
  dashboardCache.set(empresaId, { promise, expiresAt: now + CACHE_TTL_MS });
  if (dashboardCache.size > CACHE_MAX_COMPANIES) {
    dashboardCache.delete(dashboardCache.keys().next().value);
  }
  promise.catch(() => {
    if (dashboardCache.get(empresaId)?.promise === promise) dashboardCache.delete(empresaId);
  });
  return promise;
}

module.exports = {
  buildCorporateDashboard, getCachedCorporateDashboard, calendarMonthBounds, companyDocuments
};
