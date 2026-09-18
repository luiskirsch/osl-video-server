"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const waf = require("../middleware/waf");
const healthRouter = require("../routes/health");
const { normalizeAppEnv } = require("../config");
const { sanitizeNextPath } = require("../utils");

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

function routeHandler(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.at(-1).handle;
}

test("unknown APP_ENV stays fail-closed as production", () => {
  assert.equal(normalizeAppEnv("prodction"), "production");
  assert.equal(normalizeAppEnv(""), "production");
});

test("OAuth next path rejects absolute, backslash and control-character redirects", () => {
  assert.equal(sanitizeNextPath("https://evil.example/x"), "/painel.html");
  assert.equal(sanitizeNextPath("//evil.example/x"), "/painel.html");
  assert.equal(sanitizeNextPath("/\\evil.example/x"), "/painel.html");
  assert.equal(sanitizeNextPath("/ok\r\nLocation: https://evil.example"), "/painel.html");
  assert.equal(sanitizeNextPath("/painel.html?tab=discord"), "/painel.html?tab=discord");
});

test("WAF blocks encoded and double-encoded traversal", () => {
  for (const originalUrl of ["/%2e%2e%2fsecret", "/%252e%252e%252fsecret", "/..\\secret"]) {
    const req = { originalUrl, headers: {}, ip: "203.0.113.4", socket: {} };
    const res = responseRecorder();
    let nextCalled = false;
    waf(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "BAD_REQUEST");
  }
});

test("WAF rejects oversized request targets before route processing", () => {
  const req = { originalUrl: `/${"a".repeat(8192)}`, headers: {}, ip: "203.0.113.4", socket: {} };
  const res = responseRecorder();
  let nextCalled = false;
  waf(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 414);
  assert.equal(res.body.error, "URI_MUITO_LONGA");
});

test("log download is denied without an authenticated panel session", () => {
  const handler = routeHandler(healthRouter, "get", "/logs");
  const req = { query: {}, headers: {} };
  const res = responseRecorder();
  handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "ADMIN_SECRET_INVALIDO");
});

test("panel token in query is migrated to an HttpOnly cookie", () => {
  // Regression guard estrutural: EventSource não pode continuar propagando o
  // segredo pela query string a cada reconexão.
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "routes", "health.js"),
    "utf8"
  );
  assert.match(source, /HttpOnly/);
  assert.match(source, /SameSite=Strict/);
  assert.match(source, /new EventSource\("\/logs\/stream"\)/);
  assert.doesNotMatch(source, /new EventSource\("\/logs\/stream" \+ window\.location\.search\)/);
});
