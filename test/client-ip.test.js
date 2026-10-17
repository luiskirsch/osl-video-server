"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

// Cadeia medida no Railway (2026-10-17): o cliente não consegue injetar nada;
// o Railway remonta o X-Forwarded-For como "<cliente>, <proxy interno>".
const RAILWAY_XFF = "45.191.38.9, 46.151.194.130";

async function ipSeen(trustHops, headers) {
  const { globalLimiter } = require("../services/rateLimit"); // garante que o módulo carrega
  assert.ok(globalLimiter);
  const app = express();
  app.set("trust proxy", trustHops);
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
    return (await response.json()).ip;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("com 2 saltos confiáveis, o IP é o do cliente, não o do proxy do Railway", async () => {
  assert.equal(await ipSeen(2, { "X-Forwarded-For": RAILWAY_XFF }), "45.191.38.9");
  assert.equal(await ipSeen(1, { "X-Forwarded-For": RAILWAY_XFF }), "46.151.194.130"); // o defeito antigo
});

test("produção usa 2 saltos por padrão e os limites usam req.ip", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /TRUST_PROXY_HOPS \|\| \(IS_PRODUCTION \? 2 : 0\)/);
  const limits = fs.readFileSync(path.join(__dirname, "..", "services", "rateLimit.js"), "utf8");
  assert.match(limits, /function getRealIp\(req\) \{\s*return req\.ip \|\|/);
  assert.match(limits, /rateLimit\.ipKeyGenerator\(getRealIp\(req\)\)/);
  assert.doesNotMatch(limits, /keyGenerator: getRealIp/);
  assert.equal(require("express-rate-limit").ipKeyGenerator("2001:db8:abcd:12:1::5"), "2001:db8:abcd::/56");
  const therapy = fs.readFileSync(path.join(__dirname, "..", "routes", "therapy.js"), "utf8");
  assert.doesNotMatch(therapy, /x-forwarded-for/i);
});
