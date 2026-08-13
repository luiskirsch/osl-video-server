'use strict';

/**
 * services/presence.js — Presença em tempo real (lightweight)
 *
 * Estratégia: atualiza users/{uid}.lastSeenAt a cada chamada ao Hub.
 * "Online" = lastSeenAt nos últimos ONLINE_TTL_MS (5 min).
 *
 * Não usa Realtime Database nem WebSocket — funciona com o Firestore
 * que já temos. Para frequência maior de updates, o cliente pode chamar
 * PATCH /users/me/presence a cada X min.
 */

const ONLINE_TTL_MS = 5 * 60_000; // 5 minutos

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
    .catch(() => {}); // silencia se doc não existe ainda
}

/**
 * Verifica presença de múltiplos UIDs em um batch read.
 * Retorna um objeto uid → { online, lastSeenMs, displayName, photoURL }
 *
 * @param {string[]} uids
 */
async function batchCheck(uids) {
  const db = getDb();
  if (!db || !uids.length) return {};

  const cutoff = new Date(Date.now() - ONLINE_TTL_MS);

  // getAll faz uma única round-trip para até N documentos
  const refs = uids.slice(0, 30).map(uid => db.collection('users').doc(uid));
  const snaps = await db.getAll(...refs).catch(() => []);

  const result = {};
  for (const snap of snaps) {
    const data = snap.exists ? snap.data() : {};
    const lastSeen = data.lastSeenAt instanceof Date
      ? data.lastSeenAt
      : data.lastSeenAt?.toDate?.() ?? null;

    result[snap.id] = {
      online:      lastSeen ? lastSeen >= cutoff : false,
      lastSeenMs:  lastSeen?.getTime() ?? null,
      displayName: data.displayName || data.username || null,
      photoURL:    data.photoURL    || null,
    };
  }

  return result;
}

module.exports = { touch, batchCheck, ONLINE_TTL_MS };
