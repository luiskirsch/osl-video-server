'use strict';

const COMPLETED_STATUSES = new Set(['completed', 'finished', 'done']);
const CANCELED_STATUSES = new Set(['canceled', 'cancelled', 'rejected']);

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizeCouncil(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CRP/, '');
}

function cleanStatus(value) {
  return String(value || 'unknown').trim().toLowerCase().slice(0, 30) || 'unknown';
}

function isVerified(data) {
  return ['verified', 'approved', 'aprovado'].includes(cleanStatus(data.verificationStatus));
}

function isActive(data) {
  return data.disabled !== true && String(data.status || '').toLowerCase() !== 'inactive';
}

function sessionTime(data) {
  return toMillis(data.scheduledAt) || toMillis(data.completedAt) || toMillis(data.createdAt);
}

function sessionDuration(data) {
  const explicit = Number(data.durationMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.round(explicit), 1440);
  const joinedAt = toMillis(data.therapistJoinedAt);
  const completedAt = toMillis(data.completedAt);
  if (joinedAt && completedAt && completedAt > joinedAt) {
    return Math.min(Math.round((completedAt - joinedAt) / 60000), 1440);
  }
  return null;
}

function safeSession(doc) {
  const data = typeof doc.data === 'function' ? doc.data() : (doc.data || doc);
  const status = cleanStatus(data.status);
  return {
    id: String(doc.id || data.sessionId || ''),
    therapistUid: String(data.therapistUid || ''),
    scheduledAt: sessionTime(data),
    status,
    durationMinutes: sessionDuration(data),
    careOrigin: data.publicProgramId || data.publicSchoolId || data.fundingSource === 'public_contract'
      ? 'public_school'
      : 'private'
  };
}

function buildProfessionalAggregation({ professionalDocs, sessionDocs, resolveCouncil, now = Date.now() }) {
  const since30d = now - 30 * 86400000;
  const records = professionalDocs
    .map(doc => ({ id: String(doc.id), data: doc.data() }))
    .filter(record => resolveCouncil(record.data) === 'CRP');
  const recordById = new Map(records.map(record => [record.id, record]));
  const parent = new Map(records.map(record => [record.id, record.id]));

  function find(id) {
    const current = parent.get(id);
    if (current !== id) parent.set(id, find(current));
    return parent.get(id);
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  const identityOwner = new Map();
  for (const record of records) {
    const email = normalizeEmail(record.data.email);
    const council = normalizeCouncil(record.data.numeroConselho || record.data.crp || '');
    const keys = [email && `email:${email}`, council.length >= 4 && `CRP:${council}`].filter(Boolean);
    for (const key of keys) {
      if (identityOwner.has(key)) union(record.id, identityOwner.get(key));
      else identityOwner.set(key, record.id);
    }
  }

  const membersByRoot = new Map();
  for (const record of records) {
    const root = find(record.id);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(record);
  }

  const sessionsByUid = new Map();
  for (const doc of sessionDocs) {
    const session = safeSession(doc);
    if (!recordById.has(session.therapistUid)) continue;
    if (!sessionsByUid.has(session.therapistUid)) sessionsByUid.set(session.therapistUid, []);
    sessionsByUid.get(session.therapistUid).push(session);
  }

  const groups = [];
  const groupByUid = new Map();
  const allSessionStatuses = {};
  const recentSessionStatuses = {};

  for (const members of membersByRoot.values()) {
    const sessions = members.flatMap(member => sessionsByUid.get(member.id) || [])
      .sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0));
    const sessionCountByUid = new Map(members.map(member => [member.id, (sessionsByUid.get(member.id) || []).length]));
    const rankedMembers = [...members].sort((a, b) => {
      const score = member => (sessionCountByUid.get(member.id) || 0) * 100
        + (isVerified(member.data) ? 20 : 0)
        + (isActive(member.data) ? 10 : 0)
        + (normalizeEmail(member.data.email) ? 2 : 0)
        + (normalizeCouncil(member.data.numeroConselho || member.data.crp) ? 2 : 0);
      return score(b) - score(a) || String(a.id).localeCompare(String(b.id));
    });
    const canonical = rankedMembers[0];
    const canonicalData = canonical.data;
    const recentSessions = sessions.filter(session => session.scheduledAt && session.scheduledAt >= since30d);
    const statuses = {};
    const statuses30d = {};
    for (const session of sessions) {
      statuses[session.status] = (statuses[session.status] || 0) + 1;
      allSessionStatuses[session.status] = (allSessionStatuses[session.status] || 0) + 1;
      if (session.scheduledAt && session.scheduledAt >= since30d) {
        statuses30d[session.status] = (statuses30d[session.status] || 0) + 1;
        recentSessionStatuses[session.status] = (recentSessionStatuses[session.status] || 0) + 1;
      }
    }
    const verified = members.some(member => isVerified(member.data));
    const active = members.some(member => isActive(member.data));
    const councilNumber = String(
      canonicalData.numeroConselho || canonicalData.crp
      || members.map(member => member.data.numeroConselho || member.data.crp).find(Boolean)
      || ''
    ).trim();
    const group = {
      uid: canonical.id,
      memberUids: members.map(member => member.id),
      name: String(canonicalData.displayName || canonicalData.nome || 'Profissional').trim().slice(0, 100),
      email: normalizeEmail(canonicalData.email) || members.map(member => normalizeEmail(member.data.email)).find(Boolean) || '',
      council: 'CRP',
      councilNumber,
      verificationStatus: verified ? 'verified' : cleanStatus(canonicalData.verificationStatus || 'pending'),
      verified,
      active,
      createdAt: Math.min(...members.map(member => toMillis(member.data.createdAt)).filter(Boolean), Infinity),
      accountCount: members.length,
      duplicate: members.length > 1,
      sessions30d: recentSessions.length,
      completedSessions30d: recentSessions.filter(session => COMPLETED_STATUSES.has(session.status)).length,
      sessionsAllTime: sessions.length,
      completedSessionsAllTime: sessions.filter(session => COMPLETED_STATUSES.has(session.status)).length,
      canceledSessionsAllTime: sessions.filter(session => CANCELED_STATUSES.has(session.status)).length,
      lastSessionAt: sessions.find(session => session.scheduledAt)?.scheduledAt || null,
      sessionStatuses: statuses,
      sessionStatuses30d: statuses30d,
      sessions
    };
    if (!Number.isFinite(group.createdAt)) group.createdAt = null;
    groups.push(group);
    for (const member of members) groupByUid.set(member.id, group);
  }

  groups.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { groups, groupByUid, allSessionStatuses, recentSessionStatuses };
}

function publicProfessional(group) {
  const { memberUids, sessions, ...safe } = group;
  return safe;
}

module.exports = {
  COMPLETED_STATUSES,
  buildProfessionalAggregation,
  normalizeCouncil,
  publicProfessional,
  safeSession,
  toMillis
};
