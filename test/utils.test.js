"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { httpFetch, sanitizeNextPath, safeRequestPath } = require("../utils");

test("httpFetch sempre aplica deadline e não repassa opção interna", async () => {
  const originalFetch = global.fetch;
  let received;
  global.fetch = async (input, options) => {
    received = { input, options };
    return { ok: true };
  };
  try {
    await httpFetch("https://example.test/resource", { method: "GET", timeoutMs: 2_000 });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(received.input, "https://example.test/resource");
  assert.equal(received.options.method, "GET");
  assert.equal("timeoutMs" in received.options, false);
  assert.equal(received.options.signal instanceof AbortSignal, true);
});

test("redirect local rejeita URLs de protocolo relativo", () => {
  assert.equal(sanitizeNextPath("//evil.example/path"), "/painel.html");
  assert.equal(sanitizeNextPath("https://evil.example"), "/painel.html");
  assert.equal(sanitizeNextPath("/agenda.html"), "/agenda.html");
});

test("safeRequestPath remove query string e segmentos sensíveis", () => {
  const result = safeRequestPath({ originalUrl: "/reset/abcdef0123456789abcdef?token=secret" });
  assert.equal(result, "/reset/:redacted");
});
