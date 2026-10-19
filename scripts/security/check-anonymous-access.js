#!/usr/bin/env node
"use strict";
// Confere, num alvo ao vivo, que toda rota GET clínica exige login. As rotas
// são descobertas a partir do próprio app (DUMP_ROUTES em server.js), então
// rota nova entra na conferência sozinha — não há lista para manter à mão,
// só a allowlist de rotas públicas em sensitive-endpoints.js.
//
// Uso:  node scripts/security/check-anonymous-access.js <baseUrl>
//
// Exit 0 se tudo certo; exit 1 se uma rota clínica responder sem exigir login,
// ou se uma rota pública nova aparecer sem estar classificada na allowlist.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { isClinicalGet, publicSet, PUBLIC_OK } = require("./sensitive-endpoints");

const DENY_STATUS = new Set([401, 403]);
const toProbePath = routePath => routePath.replace(/:[A-Za-z0-9_]+/g, "_probe");

// Lista as rotas do app sem subir servidor (server.js imprime e sai).
function listRoutes() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
      env: { ...process.env, DUMP_ROUTES: "1", APP_ENV: "development" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const line = out.split("\n").find(l => l.includes("__ROUTES_JSON__"));
      if (!line) return reject(new Error("DUMP_ROUTES não retornou a lista de rotas"));
      try { resolve(JSON.parse(line.slice(line.indexOf("__ROUTES_JSON__") + "__ROUTES_JSON__".length))); }
      catch (e) { reject(new Error("lista de rotas inválida: " + e.message)); }
    });
  });
}

async function statusOf(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, redirect: "manual", credentials: "omit" });
    return res.status;
  } catch (error) {
    return { error: String(error.message || error).slice(0, 60) };
  }
}

async function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    console.error("Uso: node scripts/security/check-anonymous-access.js <baseUrl>");
    process.exitCode = 2;
    return;
  }

  const routes = await listRoutes();
  const mustDeny = routes.filter(isClinicalGet).filter(r => !publicSet.has(r.path));
  const failures = [];

  // Controle: a rota pública tem de responder, senão o probe está cego.
  for (const { path: p } of PUBLIC_OK) {
    const status = await statusOf(new URL(p, baseUrl).href);
    if (typeof status !== "number" || status < 200 || status >= 400) {
      failures.push(`controle público ${p} não respondeu (${status && status.error || status}); probe pode estar cego`);
    }
  }

  let ok = 0;
  for (const route of mustDeny) {
    const status = await statusOf(new URL(toProbePath(route.path), baseUrl).href);
    if (DENY_STATUS.has(status)) { ok++; continue; }
    if (typeof status !== "number") failures.push(`sem resposta em ${route.path} (${status.error})`);
    else if (status >= 200 && status < 300) failures.push(`${route.path} respondeu ${status} SEM login`);
    else failures.push(`${route.path} respondeu ${status} (esperado 401/403; se for pública, classifique em sensitive-endpoints.js)`);
  }

  console.log(`${baseUrl}: ${ok}/${mustDeny.length} rotas clínicas negam acesso anônimo`);
  if (failures.length) {
    console.error(`FALHOU (${failures.length}):`);
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
    return;
  }
  console.log("OK");
}

main().catch(error => { console.error("Erro:", error.message); process.exitCode = 1; });
