"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { safeRequestPath } = require("../utils");

test("safeRequestPath removes query strings and fragments", () => {
  assert.equal(
    safeRequestPath({ originalUrl: "/consentimento?token=segredo&email=pessoa@example.com#x" }),
    "/consentimento"
  );
});

test("safeRequestPath prefers the Express route template", () => {
  assert.equal(
    safeRequestPath({ baseUrl: "/api", route: { path: "/convites/:token" }, originalUrl: "/api/convites/segredo" }),
    "/api/convites/:token"
  );
});

test("safeRequestPath has a stable fallback", () => {
  assert.equal(safeRequestPath({}), "/");
  assert.equal(safeRequestPath(null), "/");
});

test("safeRequestPath redacts high-entropy path segments before route matching", () => {
  assert.equal(
    safeRequestPath({ originalUrl: "/convite/aVeryLongSecretTokenValue123456" }),
    "/convite/:redacted"
  );
});
