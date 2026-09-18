"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeForLog } = require("../logger");

test("logger remove credenciais e PII inclusive em objetos aninhados", () => {
  const clean = sanitizeForLog({
    authorization: "Bearer secret-token",
    nested: {
      apiKey: "super-secret",
      email: "paciente@example.com",
      note: "contato alternativo paciente@example.com",
    },
  });

  assert.equal(clean.authorization, "[REDACTED]");
  assert.equal(clean.nested.apiKey, "[REDACTED]");
  assert.equal(clean.nested.email, "[REDACTED_PII]");
  assert.equal(clean.nested.note, "contato alternativo [REDACTED_EMAIL]");
});

test("logger suporta BigInt e referências circulares sem falhar", () => {
  const value = { count: 10n };
  value.self = value;
  const clean = sanitizeForLog(value);
  assert.equal(clean.count, "10");
  assert.equal(clean.self, "[CIRCULAR]");
  assert.doesNotThrow(() => JSON.stringify(clean));
});

test("campos estruturais fornecidos em metadata não carregam segredos", () => {
  const clean = sanitizeForLog({
    tokenUsage: { input: 10, output: 5 },
    refreshToken: "abc",
    certPfxBase64: "binary-secret",
  });
  assert.deepEqual(clean.tokenUsage, { input: 10, output: 5 });
  assert.equal(clean.refreshToken, "[REDACTED]");
  assert.equal(clean.certPfxBase64, "[REDACTED]");
});
