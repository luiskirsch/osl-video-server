'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyInfluenceToDeck, TERRITORIES } = require('../services/worldState');

const limiar = {
  territoryId: TERRITORIES[0].id,
  name: TERRITORIES[0].name,
  sigil: TERRITORIES[0].sigil,
  palette: TERRITORIES[0].palette,
  affinity: TERRITORIES[0].affinity,
  effect: TERRITORIES[0].effect,
};

test('Limiar marca o deck inteiro e cria quatro ressonâncias visíveis', () => {
  const deck = [
    { type: 'Pressão', title: 'Pressão Real', text: 'A' },
    { type: 'Vínculo', title: 'Conexão Obrigatória', text: 'B' },
    { type: 'Tensão', title: 'Ruptura', text: 'C' },
    { type: 'Ritual', title: 'O Observador', text: 'D' },
    { type: 'Voto', title: 'Voto da Sala', text: 'E' },
    { type: 'Confissão', title: 'Confissão Forçada', text: 'F' },
  ];

  const result = applyInfluenceToDeck(deck, limiar);

  assert.equal(result.length, deck.length);
  assert.equal(result.filter(card => card.worldResonance === 'signature').length, 4);
  assert.ok(result.every(card => card.worldInfluence?.territoryId === 'limiar'));
  assert.ok(result.every(card => card.worldInfluence?.version === 2));
  assert.equal(result[0].worldResonance, 'signature', 'a primeira batida deve carregar ressonância');
  assert.equal(deck[0].worldInfluence, undefined, 'o deck original não deve ser mutado');
});

test('packs sem afinidade literal ainda recebem cadência territorial', () => {
  const deck = Array.from({ length: 5 }, (_, index) => ({
    type: 'Categoria Customizada', title: `Carta ${index + 1}`, text: 'Texto',
  }));

  const result = applyInfluenceToDeck(deck, limiar);

  assert.equal(result.filter(card => card.worldResonance === 'signature').length, 4);
  assert.ok(result.every(card => card.worldInfluence?.palette?.[0] === '#e7bb3f'));
});

test('metadados territoriais são clonados e não compartilham arrays mutáveis', () => {
  const result = applyInfluenceToDeck([{ type: 'Ritual', title: 'A', text: 'B' }], limiar);
  result[0].worldInfluence.palette[0] = '#000000';
  assert.equal(limiar.palette[0], '#e7bb3f');
});

