#!/usr/bin/env node
"use strict";
// Espera o Railway publicar um commit específico antes de rodar o probe, para
// não testar código antigo logo após um push. Pergunta ao /health qual commit
// está no ar e aguarda bater (ou um commit mais novo passar por cima).
//
// Uso:  node scripts/security/wait-for-deploy.js <baseUrl> <commitSha>
// Sempre sai 0: é só uma espera. Quem reprova é o probe, depois.
const { execSync } = require("node:child_process");

const TIMEOUT_MS = 12 * 60 * 1000;
const INTERVAL_MS = 15 * 1000;

async function deployedSha(baseUrl) {
  try {
    const res = await fetch(new URL("/health", baseUrl).href, { headers: { Accept: "application/json" } });
    const data = await res.json();
    return typeof data.commitSha === "string" ? data.commitSha : "";
  } catch { return ""; }
}

// O commit no ar é o nosso ou um descendente (push mais novo já subiu)?
function atOrAfter(target, deployed) {
  if (!deployed) return false;
  if (target.startsWith(deployed) || deployed.startsWith(target)) return true;
  try {
    execSync(`git merge-base --is-ancestor ${target} ${deployed}`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

async function main() {
  const [baseUrl, sha] = process.argv.slice(2);
  if (!baseUrl || !sha) { console.error("Uso: wait-for-deploy.js <baseUrl> <commitSha>"); return; }
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await deployedSha(baseUrl);
    if (atOrAfter(sha, live)) { console.log(`no ar: ${live} (alvo ${sha.slice(0, 7)})`); return; }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  console.log(`tempo esgotado esperando ${sha.slice(0, 7)} em ${baseUrl}; o probe roda mesmo assim`);
}

main().catch(() => {});
