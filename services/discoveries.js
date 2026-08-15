'use strict';

/**
 * services/discoveries.js — Sistema de Rumores / Descobertas
 *
 * Discoveries são conteúdos misteriosos que o sistema "revela" quando
 * condições são atendidas. Antes do trigger, o jogador vê apenas um teaser
 * vago ("algo está acontecendo"). Depois, pode clicar e "descobrir".
 *
 * Tipos de trigger:
 *   always             — sempre disponível
 *   community_progress — communityProgress >= triggerValue (0–1)
 *   session_count      — sessões do usuário >= triggerValue
 *   manual             — admin ativa via manuallyTriggered: true
 *
 * Firestore:
 *   discoveries/{id}                  — catálogo admin
 *   users/{uid}/discoveries/{id}      — registro por usuário (discoveredAt)
 *
 * API pública:
 *   getDiscoveries(uid, context)      → { available, teasers, totalDiscoveries }
 *   claimDiscovery(uid, discoveryId)  → { revealTitle, revealBody, reward }
 *   createDiscovery / updateDiscovery / listDiscoveries (admin)
 */

const logger = require('../logger');
const admin  = require('firebase-admin');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Trigger evaluation ────────────────────────────────────────────────────────

function _isTriggerMet(d, { worldProgress = 0, userSessionCount = 0 } = {}) {
  switch (d.triggerType) {
    case 'always':             return true;
    case 'community_progress': return worldProgress      >= (d.triggerValue || 0);
    case 'session_count':      return userSessionCount   >= (d.triggerValue || 1);
    case 'manual':             return d.manuallyTriggered === true;
    default:                   return false;
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Retorna discoveries para o usuário:
 *   available — trigger met + não descoberta pelo user → mostra botão [DESCOBRIR]
 *   teasers   — trigger não met + tem teaserText       → cria mistério
 */
async function getDiscoveries(uid, context = {}) {
  const db = getDb();
  if (!db) return { available: [], teasers: [], totalDiscoveries: 0 };

  const [discSnap, userDiscSnap] = await Promise.all([
    db.collection('discoveries').where('active', '==', true).get(),
    db.collection('users').doc(uid).collection('discoveries').get().catch(() => null),
  ]);

  const discoveredIds = new Set((userDiscSnap?.docs || []).map(d => d.id));

  const available = [];
  const teasers   = [];
  let   totalDiscoveries = 0;

  for (const doc of discSnap.docs) {
    const d = doc.data();
    totalDiscoveries += d.discoveredCount || 0;

    if (discoveredIds.has(doc.id)) continue;

    if (_isTriggerMet(d, context)) {
      available.push({
        id:          doc.id,
        revealTitle: d.revealTitle,
        revealBody:  d.revealBody  || '',
        rewardType:  d.rewardType  || null,
        rewardHint:  d.rewardHint  || null,
      });
    } else if (d.teaserText) {
      teasers.push({
        id:         doc.id,
        teaserText: d.teaserText,
      });
    }
  }

  return { available, teasers, totalDiscoveries };
}

/**
 * Marca uma discovery como descoberta pelo usuário.
 * Aplica recompensa (XP ou unlock de conteúdo).
 * Idempotente: 409 se já descoberto.
 */
async function claimDiscovery(uid, discoveryId) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');

  const discRef = db.collection('discoveries').doc(discoveryId);
  const userRef = db.collection('users').doc(uid).collection('discoveries').doc(discoveryId);

  const [discSnap, userDiscSnap] = await Promise.all([discRef.get(), userRef.get()]);

  if (!discSnap.exists || !discSnap.data().active) {
    throw Object.assign(new Error('DISCOVERY_NAO_ENCONTRADA'), { code: 404 });
  }
  if (userDiscSnap.exists) {
    throw Object.assign(new Error('JA_DESCOBERTO'), { code: 409 });
  }

  const d = discSnap.data();

  await Promise.all([
    userRef.set({ discoveredAt: new Date() }),
    discRef.update({ discoveredCount: admin.firestore.FieldValue.increment(1) }),
  ]);

  // Aplica recompensa
  let reward = null;
  try {
    if (d.rewardType === 'xp' && d.rewardValue) {
      const xpDelta = Number(d.rewardValue);
      await db.collection('users').doc(uid).update({
        xp: admin.firestore.FieldValue.increment(xpDelta),
      }).catch(() => {});
      const events = require('./events');
      events.emit('user.xp_awarded', { uid, xpDelta, source: 'discovery', discoveryId });
      reward = { type: 'xp', value: xpDelta };
    } else if (d.rewardType === 'content' && Array.isArray(d.rewardValue) && d.rewardValue.length) {
      // Conteúdo desbloqueado para todos (world unlock)
      const worldState = require('./worldState');
      await worldState.setWorldState({
        unlockedContent: admin.firestore.FieldValue.arrayUnion(...d.rewardValue),
      }).catch(() => {});
      reward = { type: 'content', value: d.rewardValue };
    }
  } catch (err) {
    logger.warn({ err, uid: uid.slice(0, 8), discoveryId }, 'discovery_reward_failed');
  }

  const events = require('./events');
  events.emit('user.discovery_claimed', { uid, discoveryId, reward });
  logger.info({ uid: uid.slice(0, 8), discoveryId, rewardType: d.rewardType }, 'discovery_claimed');

  return { id: discoveryId, revealTitle: d.revealTitle, revealBody: d.revealBody || '', reward };
}

// ── Admin ─────────────────────────────────────────────────────────────────────

async function createDiscovery(opts) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  const { id, revealTitle, teaserText, revealBody, triggerType, triggerValue, rewardType, rewardValue, rewardHint } = opts;
  if (!id || !revealTitle) throw Object.assign(new Error('DISCOVERY_INVALIDA'), { code: 400 });
  await db.collection('discoveries').doc(String(id)).set({
    id:                String(id),
    revealTitle:       String(revealTitle).slice(0, 150),
    teaserText:        String(teaserText   || '').slice(0, 200),
    revealBody:        String(revealBody   || '').slice(0, 1000),
    triggerType:       String(triggerType  || 'manual'),
    triggerValue:      Number(triggerValue) || 0,
    manuallyTriggered: false,
    rewardType:        rewardType  || null,
    rewardValue:       rewardValue ?? null,
    rewardHint:        rewardHint ? String(rewardHint).slice(0, 100) : null,
    discoveredCount:   0,
    active:            true,
    createdAt:         admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function updateDiscovery(id, patch) {
  const db = getDb();
  if (!db) throw new Error('DB_INDISPONIVEL');
  const allowed = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const k of ['revealTitle','teaserText','revealBody','triggerType','triggerValue',
                   'manuallyTriggered','rewardType','rewardValue','rewardHint','active']) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  }
  await db.collection('discoveries').doc(String(id)).update(allowed);
}

async function listDiscoveries() {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collection('discoveries').orderBy('createdAt', 'desc').limit(30).get();
  return snap.docs.map(doc => {
    const d = doc.data();
    return {
      id:               d.id,
      revealTitle:      d.revealTitle,
      teaserText:       d.teaserText,
      revealBody:       d.revealBody,
      triggerType:      d.triggerType,
      triggerValue:     d.triggerValue,
      manuallyTriggered: d.manuallyTriggered,
      rewardType:       d.rewardType,
      rewardValue:      d.rewardValue,
      rewardHint:       d.rewardHint,
      discoveredCount:  d.discoveredCount || 0,
      active:           d.active,
      createdAt:        d.createdAt?.toMillis?.() ?? null,
    };
  });
}

module.exports = { getDiscoveries, claimDiscovery, createDiscovery, updateDiscovery, listDiscoveries };
