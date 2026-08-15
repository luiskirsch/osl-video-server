'use strict';

/**
 * services/inviteLinks.js — Links de convite para salas (Priority #12)
 *
 * Um código curto (8 chars, A-Z0-9) mapeia para uma sala específica.
 * Criado pelo host; qualquer um pode resolver o código para entrar.
 *
 * Firestore: invite_links/{code}
 *   { roomId, createdBy, createdAt, expiresAt, usageCount, maxUses, revokedAt }
 *
 * API pública:
 *   createInvite(roomId, hostUid, opts)   → { code, url }
 *   resolveInvite(code)                   → { roomId, roomData } | null
 *   revokeInvite(code, hostUid)           → void
 *   listInvites(roomId)                   → Invite[]
 *   recordUsage(code)                     → void
 */

const crypto = require('crypto');
const logger = require('../logger');

const CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // sem 0/O/1/I
const CODE_LENGTH   = 8;
const DEFAULT_TTL_H = 48;   // expira em 48h por padrão

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Geração de código ─────────────────────────────────────────────────────────

function _generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

async function _uniqueCode() {
  const db = getDb();
  for (let attempts = 0; attempts < 5; attempts++) {
    const code = _generateCode();
    const snap = await db.collection('invite_links').doc(code).get();
    if (!snap.exists) return code;
  }
  throw new Error('INVITE_CODE_COLLISION');
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * @param {string} roomId
 * @param {string} hostUid
 * @param {{ ttlHours?: number, maxUses?: number|null }} opts
 */
async function createInvite(roomId, hostUid, opts = {}) {
  const db  = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const ttlHours = Number(opts.ttlHours) || DEFAULT_TTL_H;
  const maxUses  = opts.maxUses != null ? Number(opts.maxUses) : null;

  const code    = await _uniqueCode();
  const now     = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3_600_000);

  await db.collection('invite_links').doc(code).set({
    roomId,
    createdBy:  hostUid,
    createdAt:  now,
    expiresAt:  expires,
    usageCount: 0,
    maxUses,
    revokedAt:  null,
  });

  logger.info({ code, roomId, hostUid, ttlHours }, 'invite_created');
  return { code, expiresAt: expires.toISOString() };
}

async function resolveInvite(code) {
  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('invite_links').doc(code).get();
  if (!snap.exists) return null;

  const inv = snap.data();
  const now = Date.now();

  if (inv.revokedAt)                                 return null;
  if (inv.expiresAt?.toMillis?.() < now)             return null;
  if (inv.maxUses != null && inv.usageCount >= inv.maxUses) return null;

  // Carrega dados básicos da sala para o cliente poder exibir preview
  const roomSnap = await db.collection('salas').doc(inv.roomId).get().catch(() => null);
  const roomData = roomSnap?.exists ? {
    name:        roomSnap.data().name   || '',
    emoji:       roomSnap.data().emoji  || '🎴',
    playerCount: Object.keys(roomSnap.data().players || {}).length,
  } : null;

  return {
    code,
    roomId:     inv.roomId,
    createdBy:  inv.createdBy,
    expiresAt:  inv.expiresAt?.toMillis?.() ?? null,
    usageCount: inv.usageCount,
    roomData,
  };
}

async function recordUsage(code) {
  const db = getDb();
  if (!db) return;
  const admin = require('firebase-admin');
  await db.collection('invite_links').doc(code).update({
    usageCount: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
}

async function revokeInvite(code, hostUid) {
  const db   = getDb();
  if (!db) return;

  const snap = await db.collection('invite_links').doc(code).get();
  if (!snap.exists) throw Object.assign(new Error(), { code: 404 });
  if (snap.data().createdBy !== hostUid) throw Object.assign(new Error(), { code: 403 });

  await db.collection('invite_links').doc(code).update({ revokedAt: new Date() });
  logger.info({ code, hostUid }, 'invite_revoked');
}

async function listInvites(roomId) {
  const db   = getDb();
  if (!db) return [];

  const snap = await db.collection('invite_links')
    .where('roomId', '==', roomId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const now = Date.now();
  return snap.docs.map(d => {
    const inv = { code: d.id, ...d.data() };
    const expired = inv.expiresAt?.toMillis?.() < now;
    return {
      code:       inv.code,
      createdBy:  inv.createdBy,
      createdAt:  inv.createdAt?.toMillis?.() ?? null,
      expiresAt:  inv.expiresAt?.toMillis?.() ?? null,
      usageCount: inv.usageCount,
      maxUses:    inv.maxUses,
      revoked:    !!inv.revokedAt,
      expired,
      active:     !inv.revokedAt && !expired,
    };
  });
}

module.exports = { createInvite, resolveInvite, revokeInvite, listInvites, recordUsage };
