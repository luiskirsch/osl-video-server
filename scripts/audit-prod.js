#!/usr/bin/env node
// Auditoria das dependências de produção (high/critical) com exceções
// explícitas e temporárias.
//
// Uma exceção só vale para um advisory específico de um pacote específico,
// enquanto o npm NÃO oferece correção e até a data de revisão. Saiu versão
// corrigida ou passou a data: a auditoria volta a falhar sozinha.
// Só registre exceção quando o trecho vulnerável comprovadamente não roda no
// backend (ver docs/INCIDENT_RESPONSE.md, seção 2.5).
//
// Uso: node scripts/audit-prod.js [--report audit-report.json]
"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");

const EXCEPTIONS = {
  "GHSA-86w9-cpqp-85rv": {
    package: "node-forge",
    reviewBy: "2027-01-11",
    reason:
      "Falha na verificação de assinatura RSA PKCS#1 v1.5. O backend usa node-forge só para abrir o .pfx " +
      "(PKCS#12) do profissional em services/tiss-submitters/_signer.js; quem assina é o xml-crypto e nenhuma " +
      "verificação RSA passa pelo node-forge. Sem versão corrigida publicada (última: 1.4.0, em 11/10/2026).",
  },
};

const BLOCKING = new Set(["high", "critical"]);
const advisoryId = url => (String(url || "").match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i) || [])[0] || String(url || "");

/**
 * Classifica os advisories high/critical de um relatório `npm audit --json`.
 * @returns {{ failures: object[], accepted: object[], unusedExceptions: string[] }}
 */
function evaluate(report, exceptions = EXCEPTIONS, today = new Date().toISOString().slice(0, 10)) {
  const failures = [];
  const accepted = [];
  const used = new Set();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
      const id = advisoryId(via.url);
      const item = { id, package: pkg, severity: via.severity, title: via.title, url: via.url, fixAvailable: vuln.fixAvailable };
      const exception = exceptions[id];
      if (!exception || exception.package !== pkg) { failures.push({ ...item, why: "sem exceção registrada" }); continue; }
      used.add(id);
      if (vuln.fixAvailable) { failures.push({ ...item, why: "já existe correção: atualize o pacote e remova a exceção" }); continue; }
      if (today > exception.reviewBy) { failures.push({ ...item, why: `exceção vencida em ${exception.reviewBy}: revise` }); continue; }
      accepted.push({ ...item, reviewBy: exception.reviewBy, reason: exception.reason });
    }
  }
  const unusedExceptions = Object.keys(exceptions).filter(id => !used.has(id));
  return { failures, accepted, unusedExceptions };
}

function runAudit() {
  try {
    return execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // npm audit sai com código 1 quando encontra vulnerabilidades; o JSON vem no stdout.
    if (err.stdout) return err.stdout;
    throw err;
  }
}

if (require.main === module) {
  const reportPath = (() => { const i = process.argv.indexOf("--report"); return i > 0 ? process.argv[i + 1] : null; })();
  const raw = runAudit();
  if (reportPath) fs.writeFileSync(reportPath, raw);
  const report = JSON.parse(raw);
  if (report.error) { console.error("npm audit falhou:", report.error.summary || report.error); process.exit(2); }

  const { failures, accepted, unusedExceptions } = evaluate(report);
  for (const a of accepted) console.log(`ACEITO até ${a.reviewBy}: ${a.package} ${a.id} (${a.severity}) — ${a.reason}`);
  for (const id of unusedExceptions) console.log(`AVISO: a exceção ${id} não aparece mais na auditoria; remova-a de scripts/audit-prod.js.`);
  for (const f of failures) console.error(`FALHA: ${f.package} ${f.id} (${f.severity}) ${f.title} — ${f.why}. ${f.url}`);
  if (failures.length) process.exit(1);
  console.log(`Auditoria de produção ok: nenhuma vulnerabilidade high/critical fora das exceções (${accepted.length} aceita(s)).`);
}

module.exports = { evaluate, EXCEPTIONS };
