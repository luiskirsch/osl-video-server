"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPixPayload, normalizePixKey, crc16 } = require("../services/pix-brcode");

test("CRC16-CCITT matches the reference value", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("payload carries key, amount, name, city, txid and a valid CRC", () => {
  const p = buildPixPayload({
    key: "123.456.789-09", keyType: "cpf", amountCents: 18000,
    merchantName: "Ana Paula Souza", merchantCity: "São Paulo", txid: "sess_abc-123"
  });
  assert.match(p, /^000201/);
  assert.ok(p.includes("0014br.gov.bcb.pix0111" + "12345678909"));
  assert.ok(p.includes("5406180.00"));
  assert.ok(p.includes("5915ANA PAULA SOUZA"));
  assert.ok(p.includes("6009SAO PAULO"));
  assert.ok(p.includes("0510sessabc123"));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test("keys are normalized by type and invalid ones are rejected", () => {
  assert.equal(normalizePixKey("(48) 98863-7670", "telefone"), "+5548988637670");
  assert.equal(normalizePixKey("Ana@Mail.com", "email"), "ana@mail.com");
  assert.equal(normalizePixKey("123", "cpf"), null);
  assert.throws(() => buildPixPayload({ key: "123", keyType: "cpf", amountCents: 1000 }), /CHAVE_PIX_INVALIDA/);
  assert.throws(() => buildPixPayload({ key: "12345678909", keyType: "cpf", amountCents: 0 }), /VALOR_INVALIDO/);
});
