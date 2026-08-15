'use strict';

/**
 * services/fragmentEngine.js — Loop pessoal: Ritual Diário → Fragmento → Próxima Sessão
 *
 * Fluxo:
 *   live.daily_ritual_completed → issueFragment(uid) → users/{uid}.pendingFragment
 *   ritual.start (host)        → consumeFragment(uid) → injetado no deck
 *
 * Regras:
 *   - Um fragmento por usuário (completar o ritual do dia substitui o anterior)
 *   - Expira em 48h se não usado
 *   - Apenas o host consome o fragmento (outros jogadores usam quando forem host)
 *   - Seleção determinística pelo dia + cardTitle: mesmo grupo, mesmo tema
 */

const logger = require('../logger');
const admin  = require('firebase-admin');

const FRAGMENT_TTL_MS = 48 * 60 * 60 * 1000;

const FRAGMENT_POOL = [
  { title: 'O que ficou sem dizer?',     text: 'Algo aconteceu recentemente. Traga o que você não conseguiu nomear.' },
  { title: 'A pergunta que você evitou', text: 'Que pergunta você queria fazer, mas não fez? Hora de fazê-la.' },
  { title: 'Antes de continuar',         text: 'O que você ainda não processou? Deixa entrar na sala.' },
  { title: '24 horas',                   text: 'O que mudou em você nas últimas 24 horas? Não precisa ser grande.' },
  { title: 'Uma coisa real',             text: 'Nada performático. Traga algo que aconteceu de verdade.' },
  { title: 'O momento mais honesto',     text: 'Em que momento recente você foi mais honesto consigo mesmo?' },
  { title: 'O que você descobriu?',      text: 'Uma descoberta — sobre você, sobre alguém, sobre qualquer coisa.' },
  { title: 'Ainda aqui',                 text: 'O que de hoje você trouxe para essa sala sem perceber?' },
  { title: 'A pergunta certa',           text: 'Que pergunta, se feita agora, mudaria algo entre as pessoas deste grupo?' },
  { title: 'O que ficou',               text: 'De tudo que aconteceu recentemente, o que vai ficar com você?' },
];

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// Seleção determinística: mesmo dia + mesmo cardTitle = mesmo fragmento
// Garante que jogadores que fizeram o ritual juntos sempre tenham o mesmo fragmento disponível
function _selectCard(cardTitle) {
  const dateStr = new Date().toISOString().split('T')[0];
  const seed    = (dateStr + (cardTitle || '')).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const base    = FRAGMENT_POOL[seed % FRAGMENT_POOL.length];
  return { ...base, type: 'fragmento' };
}

/**
 * Emite um fragmento para o usuário após completar o ritual do dia.
 * Substitui fragmento anterior (não há acúmulo).
 */
async function issueFragment(uid, { cardTitle } = {}) {
  const db = getDb();
  if (!db || !uid) return;

  const card      = _selectCard(cardTitle);
  const expiresAt = new Date(Date.now() + FRAGMENT_TTL_MS);

  await db.collection('users').doc(uid).update({
    pendingFragment: {
      card,
      issuedAt:       new Date(),
      expiresAt,
      fromDailyRitual: true,
      dailyCardTitle:  cardTitle || null,
    },
  }).catch(() => {});
}

/**
 * Consome o fragmento pendente do usuário (leitura + deleção atômica via transação).
 * Retorna a carta ou null se não houver / expirado.
 * Chamado no início de uma sessão para injetar no deck do host.
 */
async function consumeFragment(uid) {
  const db = getDb();
  if (!db || !uid) return null;

  let card = null;

  try {
    await db.runTransaction(async (tx) => {
      const ref  = db.collection('users').doc(uid);
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const pf = snap.data().pendingFragment;
      if (!pf) return;

      const expiresAt = pf.expiresAt instanceof Date
        ? pf.expiresAt
        : pf.expiresAt?.toDate?.() ?? null;

      if (!expiresAt || expiresAt <= new Date()) {
        // Expirado: limpa silenciosamente
        tx.update(ref, { pendingFragment: admin.firestore.FieldValue.delete() });
        return;
      }

      card = pf.card;
      tx.update(ref, { pendingFragment: admin.firestore.FieldValue.delete() });
    });
  } catch (err) {
    logger.warn({ err, uid: uid.slice(0, 8) }, 'fragment_consume_failed');
  }

  return card;
}

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');

  events.on('live.daily_ritual_completed', async ({ payload }) => {
    const { authedUids, cardTitle } = payload || {};
    if (!Array.isArray(authedUids) || !authedUids.length) return;

    await Promise.all(authedUids.map(uid => issueFragment(uid, { cardTitle }).catch(() => {})));
    logger.info({ count: authedUids.length, cardTitle }, 'fragments_issued');
  });

  logger.info('fragment_engine_initialized');
}

module.exports = { issueFragment, consumeFragment, init };
