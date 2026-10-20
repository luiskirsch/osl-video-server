"use strict";

// O probe de acesso anônimo é a rede de segurança das rotas clínicas: se ele
// classificasse errado, um vazamento passaria como "ok". Aqui ele roda contra
// um servidor local que simula cada situação, usando a MESMA descoberta de
// rotas da ronda de verdade — nada de lista paralela que envelhece sozinha.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { isClinicalGet, publicSet, PUBLIC, PUBLIC_OK } = require("../scripts/security/sensitive-endpoints");
const { listRoutes, toProbePath } = require("../scripts/security/check-anonymous-access");

const PROBE = path.join(__dirname, "..", "scripts", "security", "check-anonymous-access.js");

// Descobre uma vez; cada cenário reaproveita.
let discovered;
async function clinicalRoutes() {
  if (!discovered) {
    const routes = await listRoutes();
    discovered = { routes, mustDeny: routes.filter(isClinicalGet).filter(route => !publicSet.has(route.path)) };
  }
  return discovered;
}

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

test("a descoberta entrega uma ronda coerente", async () => {
  const { routes, mustDeny } = await clinicalRoutes();
  assert.ok(routes.length >= 100, `o app precisa expor suas rotas (${routes.length})`);
  assert.ok(mustDeny.length >= 30, `a ronda não pode encolher sem querer (${mustDeny.length})`);
  const paths = mustDeny.map(route => route.path);
  assert.equal(new Set(paths).size, paths.length, "rota repetida na ronda");
  for (const { path: p } of PUBLIC_OK) assert.ok(!paths.includes(p), `${p} não pode ser pública e protegida ao mesmo tempo`);
  // Allowlist sem rota correspondente é configuração morta: se alguém criar
  // depois uma rota com esse caminho, ela nasceria liberada em silêncio.
  const clinical = new Set(routes.filter(isClinicalGet).map(route => route.path));
  const orphans = PUBLIC.filter(p => !clinical.has(p));
  assert.deepEqual(orphans, [], `allowlist aponta para rotas que não existem mais: ${orphans.join(", ")}`);
});

test("passa quando toda rota clínica nega o anônimo e o controle público responde", async () => {
  const { mustDeny } = await clinicalRoutes();
  const result = await runProbe(denyAll);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${mustDeny.length}/${mustDeny.length} rotas clínicas negam acesso anônimo`), result.stdout);
  assert.equal(result.stdout.trim().endsWith("OK"), true, result.stdout);
  assert.equal(result.seen.length, mustDeny.length + PUBLIC_OK.length);
  // Anônimo de verdade: nenhuma credencial sai na requisição.
  assert.ok(result.seen.every(request => !request.authorization && !request.cookie));
  // Parâmetros viram um valor inerte: a ronda nunca chuta um id real.
  assert.ok(result.seen.every(request => !/:[A-Za-z0-9_]/.test(request.path)));
});

test("falha se uma rota clínica devolve dados sem login", async () => {
  const { mustDeny } = await clinicalRoutes();
  const leak = mustDeny[1];
  const leakUrl = toProbePath(leak.path);
  const result = await runProbe(url => (url === leakUrl ? 200 : denyAll(url)));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`${leak.path} respondeu 200 SEM login`), result.stderr);
});

test("falha se uma rota clínica some (404) ou responde status inesperado", async () => {
  const { mustDeny } = await clinicalRoutes();
  const gone = mustDeny[2];
  const odd = mustDeny[3];
  const goneUrl = toProbePath(gone.path);
  const oddUrl = toProbePath(odd.path);
  const result = await runProbe(url => (url === goneUrl ? 404 : url === oddUrl ? 500 : denyAll(url)));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`${gone.path} respondeu 404 (esperado 401/403`), result.stderr);
  assert.ok(result.stderr.includes(`${odd.path} respondeu 500 (esperado 401/403`), result.stderr);
});

test("falha se o controle público também é barrado (probe cego)", async () => {
  const result = await runProbe(() => 401);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("controle público /health não respondeu"), result.stderr);
});
