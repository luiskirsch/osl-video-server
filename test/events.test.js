'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const events = require('../services/events');
const logger = require('../logger');

test('logger oferece as assinaturas legada e compatível', () => {
  for (const method of ['logInfo', 'logWarn', 'logError', 'info', 'warn', 'error']) {
    assert.equal(typeof logger[method], 'function', `${method} deve ser função`);
  }
});

test('emitAsync aguarda consumidores exatos e wildcard em ordem', async () => {
  const topic = `test.account.${Date.now()}`;
  const order = [];
  const unsubscribeExact = events.on(topic, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push('exact');
  });
  const unsubscribeWildcard = events.on('test.account.*', async () => {
    order.push('wildcard');
  });

  try {
    await events.emitAsync(topic, { ok: true });
    assert.deepEqual(order, ['exact', 'wildcard']);
  } finally {
    unsubscribeExact();
    unsubscribeWildcard();
  }
});

test('emitAsync aguarda listener once e ele dispara apenas uma vez', async () => {
  const topic = `test.once.${Date.now()}`;
  let calls = 0;
  events.once(topic, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    calls += 1;
  });

  await events.emitAsync(topic);
  await events.emitAsync(topic);
  assert.equal(calls, 1);
});
