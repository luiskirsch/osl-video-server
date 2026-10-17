const test = require("node:test");
const assert = require("node:assert/strict");
const scales = require("../services/scales");

test("describeResponses devolve pergunta + opção marcada na ordem da escala", () => {
  const phq9 = scales.getScale("phq9");
  const responses = { q1: 0, q2: 3, q3: 1, q4: 2, q5: 0, q6: 0, q7: 1, q8: 0, q9: 2 };
  const items = scales.describeResponses(phq9, responses);

  assert.equal(items.length, 9);
  assert.deepEqual(items.map(i => i.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(items[1].label, phq9.questions[1].label);
  assert.equal(items[1].value, 3);
  assert.equal(items[1].valueLabel, "Quase todos os dias");
  assert.equal(items[8].flag, "suicide");
  assert.equal(items[0].flag, null);
});

test("describeResponses marca item ausente ou inválido como null", () => {
  const gad7 = scales.getScale("gad7");
  const items = scales.describeResponses(gad7, { q1: 2, q2: "x", q3: 7 });

  assert.equal(items.length, 7);
  assert.equal(items[0].valueLabel, "Mais da metade dos dias");
  assert.equal(items[1].value, null);
  assert.equal(items[2].value, null);
  assert.equal(items[6].valueLabel, null);
});

test("describeResponses tolera escala desconhecida e respostas vazias", () => {
  assert.deepEqual(scales.describeResponses(null, { q1: 1 }), []);
  assert.equal(scales.describeResponses(scales.getScale("gad7"), null).length, 7);
});

test("validateAndScore continua sinalizando ideação no item 9 do PHQ-9", () => {
  const phq9 = scales.getScale("phq9");
  const all0 = Object.fromEntries(phq9.questions.map(q => [q.id, 0]));
  assert.equal(scales.validateAndScore(all0, phq9).suicideFlag, false);
  const scored = scales.validateAndScore({ ...all0, q9: 1 }, phq9);
  assert.equal(scored.suicideFlag, true);
  assert.equal(scored.score, 1);
});
