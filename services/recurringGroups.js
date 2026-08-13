'use strict';

/**
 * services/recurringGroups.js — Recurring Groups (P2 completo)
 *
 * Permite que uma sala agende sessões recorrentes (ex: "toda sexta às 21h").
 * Lembra automaticamente os membros frequentes (coreMembers do DNA) N minutos
 * antes do horário agendado via notifications inbox.
 *
 * Firestore: recurring_schedules/{roomId}
 * {
 *   roomId, dayOfWeek (0=Dom…6=Sáb UTC), utcHour, utcMinute,
 *   active, notifyMinutesBefore,
 *   createdBy, createdAt, updatedAt, lastNotifiedAt
 * }
 *
 * O check roda a cada TICK_MS (5 min). Deduplicação via lastNotifiedAt —
 * quando notificamos, gravamos o timestamp exato da próxima ocorrência;
 * checks subsequentes veem que lastNotifiedAt >= nextOccurrence e pulam.
 *
 * API pública:
 *   setSchedule(roomId, hostUid, opts)  → void
 *   getSchedule(roomId)                 → Schedule | null
 *   deactivate(roomId, hostUid)         → void
 *   init()                              → inicia loop de verificação
 */

const logger = require('../logger');

const TICK_MS              = 5 * 60_000;   // verifica a cada 5 min
const DAY_NAMES            = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

// ── Aritmética de datas (UTC puro, sem libs externas) ─────────────────────────

function _nextOccurrence(dayOfWeek, utcHour, utcMinute) {
  const now = new Date();
  let daysAhead = dayOfWeek - now.getUTCDay();
  if (daysAhead < 0) daysAhead += 7;

  // Mesmo dia mas horário já passou → próxima semana
  if (daysAhead === 0) {
    const nowMins    = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetMins = utcHour * 60 + utcMinute;
    if (nowMins >= targetMins) daysAhead = 7;
  }

  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysAhead);
  next.setUTCHours(utcHour, utcMinute, 0, 0);
  return next;
}

function _humanDayHour(dayOfWeek, utcHour, utcMinute, utcOffsetHours = -3) {
  // Converte UTC para BRT (UTC-3) para exibição human-readable
  let localHour = utcHour + utcOffsetHours;
  let localDay  = dayOfWeek;
  if (localHour < 0)  { localHour += 24; localDay = (localDay + 6) % 7; }
  if (localHour >= 24){ localHour -= 24; localDay = (localDay + 1) % 7; }
  const hh = String(localHour).padStart(2, '0');
  const mm = String(utcMinute).padStart(2, '0');
  return `${DAY_NAMES[localDay]} às ${hh}:${mm}`;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   dayOfWeek: 0-6 UTC
 *   utcHour:   0-23
 *   utcMinute: 0-59
 *   notifyMinutesBefore?: number  (padrão 30)
 */
async function setSchedule(roomId, hostUid, opts = {}) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const dayOfWeek = Number(opts.dayOfWeek);
  const utcHour   = Number(opts.utcHour);
  const utcMinute = Number(opts.utcMinute);

  if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)  throw Object.assign(new Error('DIA_INVALIDO'), { code: 400 });
  if (isNaN(utcHour)   || utcHour   < 0 || utcHour   > 23) throw Object.assign(new Error('HORA_INVALIDA'), { code: 400 });
  if (isNaN(utcMinute) || utcMinute < 0 || utcMinute > 59) throw Object.assign(new Error('MINUTO_INVALIDO'), { code: 400 });

  const notifyMinutesBefore = Number(opts.notifyMinutesBefore) || 30;
  const now = new Date();

  const doc = {
    roomId,
    dayOfWeek,
    utcHour,
    utcMinute,
    notifyMinutesBefore: Math.max(5, Math.min(120, notifyMinutesBefore)),
    active:         true,
    createdBy:      hostUid,
    updatedAt:      now,
    lastNotifiedAt: null,
  };

  const ref  = db.collection('recurring_schedules').doc(roomId);
  const snap = await ref.get();
  if (snap.exists) {
    await ref.update({ ...doc, updatedAt: now });
  } else {
    await ref.set({ ...doc, createdAt: now });
  }

  logger.info({ roomId, dayOfWeek, utcHour, utcMinute }, 'recurring_schedule_set');
}

async function getSchedule(roomId) {
  const db   = getDb();
  if (!db) return null;
  const snap = await db.collection('recurring_schedules').doc(roomId).get();
  if (!snap.exists) return null;

  const d = snap.data();
  const next = d.active ? _nextOccurrence(d.dayOfWeek, d.utcHour, d.utcMinute) : null;

  return {
    roomId:               d.roomId,
    dayOfWeek:            d.dayOfWeek,
    utcHour:              d.utcHour,
    utcMinute:            d.utcMinute,
    notifyMinutesBefore:  d.notifyMinutesBefore,
    active:               d.active,
    humanLabel:           _humanDayHour(d.dayOfWeek, d.utcHour, d.utcMinute),
    nextSessionAt:        next?.toISOString() ?? null,
    nextSessionMs:        next?.getTime()     ?? null,
    createdBy:            d.createdBy,
    createdAt:            d.createdAt?.toMillis?.() ?? null,
    updatedAt:            d.updatedAt?.toMillis?.() ?? null,
  };
}

async function deactivate(roomId, hostUid) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const snap = await db.collection('recurring_schedules').doc(roomId).get();
  if (!snap.exists) throw Object.assign(new Error('AGENDA_NAO_ENCONTRADA'), { code: 404 });
  if (snap.data().createdBy !== hostUid) throw Object.assign(new Error('SEM_PERMISSAO'), { code: 403 });

  await db.collection('recurring_schedules').doc(roomId).update({
    active: false, updatedAt: new Date(),
  });

  logger.info({ roomId, hostUid }, 'recurring_schedule_deactivated');
}

// ── Loop de verificação ───────────────────────────────────────────────────────

async function _tick() {
  const db = getDb();
  if (!db) return;

  const snap = await db.collection('recurring_schedules')
    .where('active', '==', true)
    .get()
    .catch(err => { logger.warn({ err }, 'recurring_tick_query_failed'); return null; });

  if (!snap || snap.empty) return;

  const now = Date.now();

  for (const doc of snap.docs) {
    const sched = doc.data();
    try {
      await _processSchedule(sched, now, db);
    } catch (err) {
      logger.warn({ err, roomId: sched.roomId }, 'recurring_process_failed');
    }
  }
}

async function _processSchedule(sched, now, db) {
  const next      = _nextOccurrence(sched.dayOfWeek, sched.utcHour, sched.utcMinute);
  const windowMs  = (sched.notifyMinutesBefore || 30) * 60_000;
  const distMs    = next.getTime() - now;

  // Fora da janela de notificação
  if (distMs < 0 || distMs > windowMs) return;

  // Já notificamos para essa ocorrência
  const lastMs = sched.lastNotifiedAt
    ? new Date(sched.lastNotifiedAt).getTime()
    : 0;
  if (lastMs >= next.getTime()) return;

  // Busca coreMembers do DNA da sala
  const dnaSnap = await db.collection('salas').doc(sched.roomId)
    .collection('meta').doc('dna').get().catch(() => null);

  const coreMembers = dnaSnap?.exists ? (dnaSnap.data().coreMembers || []) : [];

  // Sempre inclui o criador da agenda
  const recipients = [...new Set([...coreMembers, sched.createdBy])];

  if (!recipients.length) {
    // Mesmo sem destinatários, marca para não repetir
    await db.collection('recurring_schedules').doc(sched.roomId).update({
      lastNotifiedAt: next.toISOString(),
    }).catch(() => {});
    return;
  }

  const notifications = require('./notifications');
  const label         = _humanDayHour(sched.dayOfWeek, sched.utcHour, sched.utcMinute);
  const minutesLeft   = Math.round(distMs / 60_000);

  for (const uid of recipients) {
    await notifications.createNotification(uid, {
      type:  'session_reminder',
      title: 'Sessão em breve!',
      body:  `${label} — em ~${minutesLeft} min. Hora de juntar o grupo.`,
      data:  {
        roomId:       sched.roomId,
        nextSessionAt: next.toISOString(),
      },
    }).catch(() => {});
  }

  // Grava a ocorrência notificada para deduplicação
  await db.collection('recurring_schedules').doc(sched.roomId).update({
    lastNotifiedAt: next.toISOString(),
  }).catch(() => {});

  const events = require('./events');
  events.emit('live.session_reminder_sent', {
    roomId:       sched.roomId,
    nextSessionAt: next.toISOString(),
    recipients:   recipients.length,
  });

  logger.info({
    roomId: sched.roomId, label, recipients: recipients.length, minutesLeft,
  }, 'session_reminder_sent');
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _initialized  = false;
let _intervalHandle = null;

function init() {
  if (_initialized) return;
  _initialized = true;

  // Primeira verificação logo após boot (delay de 30s para serviços estabilizarem)
  setTimeout(() => {
    _tick().catch(err => logger.warn({ err }, 'recurring_tick_initial_failed'));
    _intervalHandle = setInterval(() => {
      _tick().catch(err => logger.warn({ err }, 'recurring_tick_failed'));
    }, TICK_MS);
  }, 30_000);

  logger.info({ tickIntervalMin: TICK_MS / 60_000 }, 'recurring_groups_initialized');
}

function stop() {
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = null;
}

module.exports = { setSchedule, getSchedule, deactivate, init, stop };
