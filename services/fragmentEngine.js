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
  { title: 'O que ficou sem dizer?', text: 'Algo aconteceu recentemente. Traga o que você não conseguiu nomear.', territoryId: 'limiar', rarity: 'incomum', sigil: '◉', palette: ['#d4af37','#10202a'], effect: 'Abre o ritual antes da primeira carta comum.' },
  { title: 'A pergunta que você evitou', text: 'Que pergunta você queria fazer, mas não fez? Hora de fazê-la.', territoryId: 'entrelinhas', rarity: 'raro', sigil: '△', palette: ['#60a6a8','#081b22'], effect: 'Conduz o grupo diretamente ao que não foi dito.' },
  { title: 'Antes de continuar', text: 'O que você ainda não processou? Deixe isso entrar na sala.', territoryId: 'camara', rarity: 'incomum', sigil: '□', palette: ['#a884d8','#150e20'], effect: 'Transforma uma memória recente em matéria do ritual.' },
  { title: '24 horas', text: 'O que mudou em você nas últimas 24 horas? Não precisa ser grande.', territoryId: 'limiar', rarity: 'comum', sigil: '◉', palette: ['#d4af37','#10202a'], effect: 'Liga o ritual de hoje ao mundo que continuou sem você.' },
  { title: 'Uma coisa real', text: 'Nada performático. Traga algo que aconteceu de verdade.', territoryId: 'camara', rarity: 'raro', sigil: '□', palette: ['#a884d8','#150e20'], effect: 'Aumenta a presença coletiva desta sessão.' },
  { title: 'O momento mais honesto', text: 'Em que momento recente você foi mais honesto consigo mesmo?', territoryId: 'sexto_lugar', rarity: 'lendário', sigil: '◇', palette: ['#f0e4bd','#26180d'], effect: 'Um vestígio raro atravessa todas as fronteiras.' },
  { title: 'O que você descobriu?', text: 'Uma descoberta — sobre você, sobre alguém, sobre qualquer coisa.', territoryId: 'entrelinhas', rarity: 'incomum', sigil: '△', palette: ['#60a6a8','#081b22'], effect: 'Registra uma memória nas Entrelinhas.' },
  { title: 'Ainda aqui', text: 'O que de hoje você trouxe para essa sala sem perceber?', territoryId: 'limiar', rarity: 'comum', sigil: '◉', palette: ['#d4af37','#10202a'], effect: 'Torna visível o elo entre dois rituais.' },
  { title: 'A pergunta certa', text: 'Que pergunta, se feita agora, mudaria algo entre as pessoas deste grupo?', territoryId: 'sexto_lugar', rarity: 'lendário', sigil: '◇', palette: ['#f0e4bd','#26180d'], effect: 'Permite ao grupo nomear o que mudou entre vocês.' },
  { title: 'O que ficou', text: 'De tudo que aconteceu recentemente, o que vai ficar com você?', territoryId: 'entrelinhas', rarity: 'raro', sigil: '△', palette: ['#60a6a8','#081b22'], effect: 'Converte o encerramento em um vestígio persistente.' },
];

function sanitizeFragmentCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const title = typeof card.title === 'string' ? card.title.trim().slice(0, 160) : '';
  const text  = typeof card.text === 'string' ? card.text.trim().slice(0, 1200) : '';
  if (!title || !text) return null;
  const palette = (Array.isArray(card.palette) ? card.palette : []).slice(0, 2).map(color => /^#[0-9a-f]{6}$/i.test(color) ? color : null).filter(Boolean);
  return { title, text, type: 'fragmento', fragmentId: String(card.fragmentId || '').slice(0, 80) || null, territoryId: String(card.territoryId || 'limiar').slice(0, 40), rarity: String(card.rarity || 'comum').slice(0, 20), sigil: String(card.sigil || '◉').slice(0, 4), palette: palette.length === 2 ? palette : ['#d4af37','#10202a'], effect: String(card.effect || '').slice(0, 240) };
}

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
  return { ...base, fragmentId: `FRG-${dateStr.replace(/-/g, '')}-${String(seed % 997).padStart(3, '0')}`, type: 'fragmento' };
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

  try {
    // O valor retornado pertence à tentativa que efetivamente fez commit.
    // Não mantenha resultado em variável externa: callbacks de transação
    // podem ser executados novamente em caso de contenção.
    return await db.runTransaction(tx => claimFragmentInTransaction(tx, uid, db));
  } catch (err) {
    logger.warn({ err, uid: uid.slice(0, 8) }, 'fragment_consume_failed');
    return null;
  }
}

/**
 * Variante composável para reservar o fragmento na mesma transação que cria a
 * sessão. Evita consumir uma carta quando outra chamada concorrente vence o
 * start ou quando a criação da sessão falha.
 */
async function claimFragmentInTransaction(tx, uid, db = getDb()) {
  if (!tx || !db || !uid) return null;
  const ref = db.collection('users').doc(uid);
  const snap = await tx.get(ref);
  if (!snap.exists) return null;

  const pending = snap.data().pendingFragment;
  if (!pending) return null;
  const expiresAt = pending.expiresAt instanceof Date
    ? pending.expiresAt
    : pending.expiresAt?.toDate?.() ?? null;

  tx.update(ref, { pendingFragment: admin.firestore.FieldValue.delete() });
  if (!expiresAt || expiresAt <= new Date()) return null;
  return sanitizeFragmentCard(pending.card);
}

/**
 * Insere o fragmento reservado no primeiro terço do ritual sem modificar o
 * array original. Função pura para manter o mesmo contrato em start/reset.
 */
function insertFragmentIntoDeck(deck, fragment) {
  const reservedDeck = Array.isArray(deck) ? deck.slice() : [];
  if (!fragment) return reservedDeck;
  const position = Math.max(1, Math.floor(reservedDeck.length / 3));
  reservedDeck.splice(Math.min(position, reservedDeck.length), 0, fragment);
  return reservedDeck;
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

module.exports = { issueFragment, consumeFragment, claimFragmentInTransaction, insertFragmentIntoDeck, init };
