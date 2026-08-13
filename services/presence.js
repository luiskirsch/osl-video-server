'use strict';

/**
 * services/presence.js — Presença em tempo real (lightweight)
 *
 * Estratégia: atualiza users/{uid}.lastSeenAt a cada chamada ao Hub.
 * "Online" = lastSeenAt nos últimos ONLINE_TTL_MS (5 min).
 *
 * Também retorna lastActivity (tipo de sessão em andamento) do usuário.
 * Atividade com mais de ACTIVITY_STALE_MS (90 min) é tratada como null.
 */

const ONLINE_TTL_MS   = 5  * 60_000; // 5 minutos
const ACTIVITY_STALE_MS = 90 * 60_000; // 90 minutos

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

/**
 * Marca o usuário como "visto agora" (fire-and-forget — não bloqueia request).
 */
async function touch(uid) {
  const db = getDb();
  if (!db || !uid) return;
  await db.collection('users').doc(uid)
    .update({ lastSeenAt: new Date() })
    .catch(() => {});
}

/**
 * Verifica presença de múltiplos UIDs em um batch read.
 * Retorna um objeto uid → { online, lastSeenMs, displayName, photoURL, lastActivity }
 *
 * @param {string[]} uids
 */
async function batchCheck(uids) {
  const db = getDb();
  if (!db || !uids.length) return {};

  const now    = Date.now();
  const cutoff = new Date(now - ONLINE_TTL_MS);

  const refs  = uids.slice(0, 30).map(uid => db.collection('users').doc(uid));
  const snaps = await db.getAll(...refs).catch(() => []);

  const result = {};
  for (const snap of snaps) {
    const data = snap.exists ? snap.data() : {};

    const lastSeen = data.lastSeenAt instanceof Date
      ? data.lastSeenAt
      : data.lastSeenAt?.toDate?.() ?? null;

    // Atividade: stale se startedAt > 90 min atrás
    const rawActivity  = data.lastActivity || null;
    const activityAt   = data.lastActivityAt instanceof Date
      ? data.lastActivityAt
      : data.lastActivityAt?.toDate?.() ?? null;
    const activityFresh = activityAt ? (now - activityAt.getTime()) < ACTIVITY_STALE_MS : false;

    result[snap.id] = {
      online:       lastSeen ? lastSeen >= cutoff : false,
      lastSeenMs:   lastSeen?.getTime() ?? null,
      displayName:  data.displayName || data.username || null,
      photoURL:     data.photoURL    || null,
      lastActivity: (rawActivity && activityFresh) ? {
        type:      rawActivity.type,
        roomId:    rawActivity.roomId,
        startedAt: activityAt?.getTime() ?? null,
      } : null,
    };
  }

  return result;
}

module.exports = { touch, batchCheck, ONLINE_TTL_MS, ACTIVITY_STALE_MS };
