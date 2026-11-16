#!/usr/bin/env node
// Publica security/firebase/sextolugar.firestore.rules no projeto Firebase do
// jogo (osextolugar-jogo) pela API do Firebase Rules, sem depender do login
// do Firebase CLI. Usa a credencial do gcloud (`gcloud auth login`).
//
// Uso: node scripts/publicar-regras-jogo.js
"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { GAME_PROJECT } = require("../services/firebase-isolation");

const RULES = path.join(__dirname, "..", "security", "firebase", "sextolugar.firestore.rules");
const API = `https://firebaserules.googleapis.com/v1/projects/${GAME_PROJECT}`;
const RELEASE = `projects/${GAME_PROJECT}/releases/cloud.firestore`;

async function call(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": GAME_PROJECT, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

(async () => {
  const token = execSync("gcloud auth print-access-token", { encoding: "utf8", shell: true }).trim();
  const content = fs.readFileSync(RULES, "utf8");

  const ruleset = await call(token, "POST", `${API}/rulesets`, { source: { files: [{ name: "firestore.rules", content }] } });
  if (!ruleset.ok) throw new Error(`Regras recusadas (${ruleset.status}): ${JSON.stringify(ruleset.data.error || ruleset.data)}`);
  const rulesetName = ruleset.data.name;

  const current = await call(token, "GET", `${API}/releases/cloud.firestore`);
  const release = current.ok
    ? await call(token, "PATCH", `${API}/releases/cloud.firestore`, { release: { name: RELEASE, rulesetName } })
    : await call(token, "POST", `${API}/releases`, { name: RELEASE, rulesetName });
  if (!release.ok) throw new Error(`Falha ao publicar (${release.status}): ${JSON.stringify(release.data.error || release.data)}`);

  console.log(`Regras do Firestore publicadas em ${GAME_PROJECT}: ${rulesetName}`);
})().catch(error => { console.error(`✖ ${error.message}`); process.exit(1); });
