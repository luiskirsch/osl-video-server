"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

test("QA do jogo aceita exclusivamente o webhook assinado para o pagamento indicado", () => {
  Object.assign(process.env, {
    APP_ENV: "staging", SERVICE_PRODUCT: "sextolugar", STAGING_MP_WEBHOOK: "1",
    MP_WEBHOOK_SECRET_JOGO: crypto.randomBytes(32).toString("hex"),
  });
  const guard = require("../middleware/stagingAccess");
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", process.env.MP_WEBHOOK_SECRET_JOGO)
    .update("id:123;request-id:qa;ts:" + ts + ";").digest("hex");
  const req = { method: "POST", path: "/webhook", query: { "data.id": "123" },
    headers: { "x-request-id": "qa", "x-signature": "ts=" + ts + ",v1=" + sig } };
  const run = input => {
    let allowed = false;
    guard(input, { setHeader() {}, status() { return this; }, json() {} }, () => { allowed = true; });
    return allowed;
  };
  assert.equal(run(req), true);
  assert.equal(run({ ...req, headers: {} }), false);
  assert.equal(run({ ...req, query: { "data.id": "124" } }), false);
  assert.equal(run({ ...req, path: "/recording/claim" }), false);
  delete process.env.STAGING_MP_WEBHOOK;
  assert.equal(run(req), false);
});
