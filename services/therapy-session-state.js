'use strict';

const DEFAULT_SESSION_DURATION_MINUTES = 60;
const SESSION_OVERDUE_GRACE_MINUTES = 30;
const MIN_SESSION_DURATION_MINUTES = 15;
const MAX_SESSION_DURATION_MINUTES = 240;

function therapySessionDurationMinutes(session = {}) {
  const rawDuration = session.durationMinutes;
  if (rawDuration == null || rawDuration === '') return DEFAULT_SESSION_DURATION_MINUTES;
  const duration = Number(rawDuration);
  if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_SESSION_DURATION_MINUTES;
  return Math.min(MAX_SESSION_DURATION_MINUTES, Math.max(MIN_SESSION_DURATION_MINUTES, duration));
}

function therapySessionOverdueAt(session = {}) {
  const scheduledAt = Number(session.scheduledAt);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) return null;
  const durationMs = therapySessionDurationMinutes(session) * 60 * 1000;
  const graceMs = SESSION_OVERDUE_GRACE_MINUTES * 60 * 1000;
  return scheduledAt + durationMs + graceMs;
}

function isTherapySessionOverdue(session = {}, now = Date.now()) {
  if (!['scheduled', 'in_progress'].includes(session.status)) return false;
  const overdueAt = therapySessionOverdueAt(session);
  return overdueAt !== null && Number(now) >= overdueAt;
}

function selectTherapyPanelSessions(sessions = [], now = Date.now()) {
  const active = sessions.filter(session =>
    session?.scheduledAt && ['scheduled', 'in_progress'].includes(session.status)
  );
  const current = active
    .filter(session => !isTherapySessionOverdue(session, now))
    .sort((a, b) => Number(a.scheduledAt || 0) - Number(b.scheduledAt || 0));
  const overdue = active
    .filter(session => isTherapySessionOverdue(session, now))
    .sort((a, b) => Number(b.scheduledAt || 0) - Number(a.scheduledAt || 0));
  return {
    nextSession: current[0] || null,
    overdueSession: overdue[0] || null
  };
}

module.exports = {
  DEFAULT_SESSION_DURATION_MINUTES,
  SESSION_OVERDUE_GRACE_MINUTES,
  therapySessionDurationMinutes,
  therapySessionOverdueAt,
  isTherapySessionOverdue,
  selectTherapyPanelSessions
};
