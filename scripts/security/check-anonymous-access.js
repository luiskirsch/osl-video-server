#!/usr/bin/env node
"use strict";
// Probe ao vivo: chama os endpoints clínicos sem autenticação (sem cabeçalho
// Authorization, sem cookies) e confirma que o servidor NEGA — exatamente o
// teste da seção 5 do relatório, só que do lado defensivo e automatizado.
//
// Uso:  node scripts/security/check-anonymous-access.js <baseUrl>
//   ex: node scripts/security/check-anonymous-access.js https://api.espacopreludio.com.br
//
// Saída: tabela + exit 0 se tudo negado (401/403); exit 1 se qualquer rota
// sensível vazar (2xx), sumir (404) ou não exigir login. Pensado para rodar
// contra produção/staging num job agendado.
const { DENIED, PUBLIC_OK } = require("./sensitive-endpoints");

const DENY_STATUS = new Set([401, 403]);

async function probe(baseUrl, path) {
  const url = new URL(path, baseUrl).href;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      // Anônimo de verdade: nenhum Authorization, nenhum cookie.
      credentials: "omit",
    });
    return { status: res.status };
  } catch (error) {
    return { status: 0, error: String(error.message || error).slice(0, 60) };
  }
}

async function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    console.error("Uso: node scripts/security/check-anonymous-access.js <baseUrl>");
    process.exit(2);
  }
  const failures = [];

  // Controle positivo: a rota pública tem de responder, senão o probe está cego.
  for (const { path, label } of PUBLIC_OK) {
    const { status, error } = await probe(baseUrl, path);
    if (status < 200 || status >= 400) {
      failures.push(`CONTROLE FALHOU ${path} (${label}) → ${error || status}; probe pode estar cego`);
      console.log(`  ?? ${path.padEnd(42)} ${error || status}  (controle público)`);
    } else {
      console.log(`  ok ${path.padEnd(42)} ${status}  (controle público)`);
    }
  }

  for (const { path, label } of DENIED) {
    const { status, error } = await probe(baseUrl, path);
    if (error) {
      failures.push(`SEM RESPOSTA ${path} (${label}) → ${error}`);
      console.log(`  ?? ${path.padEnd(42)} ${error}`);
    } else if (DENY_STATUS.has(status)) {
      console.log(`  ok ${path.padEnd(42)} ${status}  nega anônimo`);
    } else if (status >= 200 && status < 300) {
      failures.push(`VAZAMENTO ${path} (${label}) → ${status} para chamador anônimo`);
      console.log(`  XX ${path.padEnd(42)} ${status}  <<< VAZA SEM LOGIN`);
    } else if (status === 404) {
      failures.push(`ROTA SUMIU ${path} (${label}) → 404; atualize sensitive-endpoints.js`);
      console.log(`  XX ${path.padEnd(42)} 404  <<< rota não existe mais`);
    } else {
      failures.push(`STATUS INESPERADO ${path} (${label}) → ${status} (esperado 401/403)`);
      console.log(`  XX ${path.padEnd(42)} ${status}  <<< esperado 401/403`);
    }
  }

  console.log("");
  if (failures.length) {
    console.error(`FALHOU: ${failures.length} problema(s) de autorização anônima em ${baseUrl}`);
    for (const f of failures) console.error("  - " + f);
    // exitCode em vez de process.exit(): no Windows, sair à força com conexões
    // do fetch ainda abertas derruba o Node (0xC0000409) em vez de devolver 1.
    process.exitCode = 1;
    return;
  }
  console.log(`OK: ${DENIED.length} endpoints clínicos negam acesso anônimo em ${baseUrl}`);
}

main().catch(error => { console.error("Erro no probe:", error.message); process.exitCode = 1; });
