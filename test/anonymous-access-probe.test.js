"use strict";

// O probe de acesso anônimo é a rede de segurança das rotas clínicas: se ele
// classificasse errado, um vazamento passaria como "ok". Aqui ele roda contra
// um servidor local que simula cada situação.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { DENIED, PUBLIC_OK } = require("../scripts/security/sensitive-endpoints");

const PROBE = path.join(__dirname, "..", "scripts", "security", "check-anonymous-access.js");

async function runProbe(statusFor) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(statusFor(req.url), { "Content-Type": "application/json" }).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await new Promise(resolve => {
      execFile(process.execPath, [PROBE, base], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    return { ...result, seen };
  } finally {
    server.close();
  }
}
const denyAll = url => (url === "/health" ? 200 : 401);

test("a lista de rotas sensíveis é coerente", () => {
  const paths = DENIED.map(entry => entry.path);
  assert.ok(paths.length >= 30, "a lista não pode encolher sem querer");
  assert.equal(new Set(paths).size, paths.length, "rota repetida");
  for (const p of paths) assert.match(p, /^\/[a-z0-9/-]+$/, p);
  for (const { path: p } of PUBLIC_OK) assert.ok(!paths.includes(p), `${p} não pode ser pública e protegida ao mesmo tempo`);
});

test("passa quando toda rota sensível nega o anônimo e o controle público responde", async () => {
  const result = await runProbe(denyAll);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`OK: ${DENIED.length} endpoints`), result.stdout);
  assert.equal(result.seen.length, DENIED.length + PUBLIC_OK.length);
  // Anônimo de verdade: nenhuma credencial sai na requisição.
  assert.ok(result.seen.every(request => !request.authorization && !request.cookie));
});

test("falha se uma rota sensível devolve dados sem login", async () => {
  const leak = DENIED[1].path;
  const result = await runProbe(url => (url === leak ? 200 : denyAll(url)));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`VAZAMENTO ${leak} `), result.stderr);
});

test("falha se uma rota sensível some (404) ou responde status inesperado", async () => {
  const gone = DENIED[2].path;
  const odd = DENIED[3].path;
  const result = await runProbe(url => (url === gone ? 404 : url === odd ? 500 : denyAll(url)));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`ROTA SUMIU ${gone} `), result.stderr);
  assert.ok(result.stderr.includes(`STATUS INESPERADO ${odd} `), result.stderr);
});

test("falha se o controle público também é barrado (probe cego)", async () => {
  const result = await runProbe(() => 401);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("CONTROLE FALHOU /health"), result.stderr);
});
