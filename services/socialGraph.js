'use strict';

/**
 * services/socialGraph.js — Social Graph automático por co-play
 *
 * Detecta automaticamente quando dois jogadores autenticados participam
 * da mesma sessão e incrementa a conexão entre eles.
 *
 * Coleção Firestore: social_connections/{uid_a}_{uid_b}
 *   uid_a < uid_b (normalização lexicográfica — evita duplicatas)
 *
 * Schema:
 * {
 *   uid_a:         string,
 *   uid_b:         string,
 *   sessionCount:  number,    // sessões juntos
 *   sharedRooms:   string[],  // salas onde jogaram juntos (deduplicado)
 *   firstPlayedAt: Date,
 *   lastPlayedAt:  Date,
 * }
 *
 * API pública:
 *   init()                           → registra listener no EventBus
 *   getConnections(uid, limit?)      → conexões ordenadas por sessionCount
 *   getConnection(uid_a, uid_b)      → conexão entre dois jogadores
 */

const logger = require('../logger');
const events  = require('./events');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').db;
  return _db;
}

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  events.on('session.ended', async ({ payload }) => {
    const { roomId, sessionId, players } = payload || {};
    if (!roomId || !sessionId || !Array.isArray(players)) return;

    // Apenas jogadores autenticados (uid presente)
    const authedUids = [...new Set(
      players.map(p => p.userId || null).filter(Boolean)
    )];

    if (authedUids.length < 2) return;

    await _updateConnections(authedUids, roomId).catch(err =>
      logger.error({ err, roomId, sessionId }, 'social_graph_update_failed')
    );
  });

  logger.info({}, 'social_graph_initialized');
}

// ── Computação ────────────────────────────────────────────────────────────────

async function _updateConnections(uids, roomId) {
  const db  = getDb();
  if (!db) return;

  const admin = require('firebase-admin');
  const now   = new Date();
  const batch = db.batch();

  // Todas as combinações par-a-par
  for (let i = 0; i < uids.length; i++) {
    for (let j = i + 1; j < uids.length; j++) {
      const uid_a = uids[i] < uids[j] ? uids[i] : uids[j];
      const uid_b = uids[i] < uids[j] ? uids[j] : uids[i];
      const docId = `${uid_a}_${uid_b}`;
      const ref   = db.collection('social_connections').doc(docId);

      const snap = await ref.get();
      if (snap.exists) {
        batch.update(ref, {
          sessionCount:  admin.firestore.FieldValue.increment(1),
          sharedRooms:   admin.firestore.FieldValue.arrayUnion(roomId),
          lastPlayedAt:  now,
        });
      } else {
        batch.set(ref, {
          uid_a, uid_b,
          sessionCount:  1,
          sharedRooms:   [roomId],
          firstPlayedAt: now,
          lastPlayedAt:  now,
        });
      }
    }
  }

  await batch.commit();
  logger.info({ uids: uids.length, pairs: uids.length * (uids.length - 1) / 2, roomId },
    'social_graph_updated');
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getConnections(uid, limit = 20) {
  const db = getDb();
  if (!db) return [];

  // Dois queries (uid como uid_a e uid como uid_b) — Firestore não suporta OR
  const [snapA, snapB] = await Promise.all([
    db.collection('social_connections').where('uid_a', '==', uid).orderBy('sessionCount', 'desc').limit(limit).get(),
    db.collection('social_connections').where('uid_b', '==', uid).orderBy('sessionCount', 'desc').limit(limit).get(),
  ]);

  const connections = new Map();  // otherUid → data

  for (const doc of [...snapA.docs, ...snapB.docs]) {
    const d        = doc.data();
    const otherUid = d.uid_a === uid ? d.uid_b : d.uid_a;
    const existing = connections.get(otherUid);
    if (!existing || d.sessionCount > existing.sessionCount) {
      connections.set(otherUid, {
        uid:           otherUid,
        sessionCount:  d.sessionCount,
        sharedRooms:   d.sharedRooms || [],
        firstPlayedAt: d.firstPlayedAt?.toMillis?.() || null,
        lastPlayedAt:  d.lastPlayedAt?.toMillis?.()  || null,
      });
    }
  }

  return Array.from(connections.values())
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, limit);
}

async function getConnection(uid_a, uid_b) {
  const db = getDb();
  if (!db) return null;
  const a = uid_a < uid_b ? uid_a : uid_b;
  const b = uid_a < uid_b ? uid_b : uid_a;
  const snap = await db.collection('social_connections').doc(`${a}_${b}`).get();
  return snap.exists ? snap.data() : null;
}

module.exports = { init, getConnections, getConnection };
