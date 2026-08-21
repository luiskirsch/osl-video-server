'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
if (!admin.firestore) admin.firestore = { FieldValue: { delete: () => ({ __delete: true }) } };
const { claimFragmentInTransaction, insertFragmentIntoDeck } = require('../services/fragmentEngine');

test('reserva fragmento válido e preserva toda a identidade da carta', async () => {
  const updates = [];
  const pending = {
    expiresAt: { toDate: () => new Date(Date.now() + 60_000) },
    card: {
      title: 'A pergunta que você evitou', text: 'Que pergunta você queria fazer?',
      fragmentId: 'FRG-20260821-534', territoryId: 'entrelinhas', rarity: 'raro',
      sigil: '△', palette: ['#60a6a8', '#081b22'], effect: 'Conduz o grupo ao não dito.',
    },
  };
  const ref = { path: 'users/uid-1' };
  const db = { collection: () => ({ doc: () => ref }) };
  const tx = {
    get: async () => ({ exists: true, data: () => ({ pendingFragment: pending }) }),
    update: (...args) => updates.push(args),
  };

  const fragment = await claimFragmentInTransaction(tx, 'uid-1', db);
  assert.equal(fragment.type, 'fragmento');
  assert.equal(fragment.fragmentId, 'FRG-20260821-534');
  assert.equal(fragment.territoryId, 'entrelinhas');
  assert.equal(fragment.rarity, 'raro');
  assert.deepEqual(fragment.palette, ['#60a6a8', '#081b22']);
  assert.equal(updates.length, 1, 'a reserva remove o pendente na mesma transação');
});

test('insere fragmento no primeiro terço sem substituir ou perder cartas', () => {
  const deck = Array.from({ length: 12 }, (_, i) => ({ title: `Carta ${i + 1}`, text: 'Texto' }));
  const fragment = { title: 'Fragmento', text: 'Texto', type: 'fragmento', fragmentId: 'FRG-1' };
  const result = insertFragmentIntoDeck(deck, fragment);

  assert.equal(result.length, 13);
  assert.equal(result[4], fragment);
  assert.equal(result.filter(card => card.type === 'fragmento').length, 1);
  assert.equal(deck.length, 12, 'o deck original permanece intacto');
});

test('sem fragmento mantém uma cópia íntegra do deck', () => {
  const deck = [{ title: 'Carta', text: 'Texto' }];
  const result = insertFragmentIntoDeck(deck, null);
  assert.deepEqual(result, deck);
  assert.notEqual(result, deck);
});
