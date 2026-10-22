#!/usr/bin/env node
// Publica o backend a partir do PC sem depender do builder do Railway.
//
// O workflow "Imagem do backend" monta uma imagem por commit no GitHub
// Container Registry. Este comando entrega essa imagem pronta ao Railway:
// primeiro no staging, confere o /health e só então na produção.
//
// Uso (na pasta do projeto, depois do push):
//   npm run publicar                     staging e produção
//   npm run publicar -- --so-staging     só o staging
//   npm run publicar -- --voltar-github  devolve os dois ambientes ao deploy
//                                        automático pelo GitHub (Railway normal)
//
// Requer: git, gh (logado no GitHub) e railway (logado: `railway login`).
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROJECT = "59d374df-cced-40ba-9dc4-bc76a354a5ab";
const SERVICE = "8a9e0d20-1ae1-4be0-83c3-37074540f256";
const REPOSITORY = "luiskirsch/osl-video-server";
const BRANCH = "luiskirsch.github.io";
const IMAGE = `ghcr.io/${REPOSITORY}`;
const WORKFLOW = "backend-image.yml";
const ENVIRONMENTS = [
  { name: "staging", id: "796bde59-e2cf-434b-a12e-aa4cb6dfe6cb", health: "https://api-staging.espacopreludio.com.br/health" },
  { name: "produção", id: "692963fc-d597-456c-b524-0daeb3035aef", health: "https://api.espacopreludio.com.br/health" },
];

const args = new Set(process.argv.slice(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = message => console.log(`[${new Date().toLocaleTimeString("pt-BR")}] ${message}`);
function stop(message) { console.error(`\n✖ ${message}`); process.exit(1); }

function run(command, commandArgs, { allowFailure = false } = {}) {
  // An invalid RAILWAY_TOKEN in the environment overrides the CLI login.
  const env = { ...process.env };
  delete env.RAILWAY_TOKEN;
  const result = spawnSync(command, commandArgs, { cwd: ROOT, env, encoding: "utf8", windowsHide: true });
  if (!allowFailure && result.status !== 0) stop(`${command} ${commandArgs.join(" ")} falhou:\n${result.stderr || result.stdout || result.error?.message}`);
  return (result.stdout || "").trim();
}

async function railway(query, variables) {
  // The CLI access token lasts one hour; `whoami` renews it from the refresh token.
  run("railway", ["whoami"], { allowFailure: true });
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8")).user.accessToken; }
  catch { stop("Railway sem login neste PC. Rode `railway login` e tente de novo."); }
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json().catch(() => ({}));
  const message = data.errors?.[0]?.message || (response.ok ? "" : `HTTP ${response.status}`);
  if (/not authorized|unauthorized/i.test(message)) stop("O login do Railway expirou. Rode `railway login` numa janela do terminal, aprove no navegador e tente de novo.");
  if (message) throw new Error(message);
  return data.data;
}

async function liveCommit(url) {
  try { return (await (await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })).json()).commitSha || null; }
  catch { return null; }
}

async function waitForImage(sha) {
  say(`Aguardando a imagem do commit ${sha.slice(0, 7)} no GitHub…`);
  const deadline = Date.now() + 40 * 60 * 1000;
  let dispatched = false;
  while (Date.now() < deadline) {
    const runs = JSON.parse(run("gh", ["run", "list", "--workflow", WORKFLOW, "--commit", sha, "--json", "status,conclusion,url", "--limit", "1"]) || "[]");
    if (runs[0]?.status === "completed") {
      if (runs[0].conclusion !== "success") stop(`A montagem da imagem falhou: ${runs[0].url}`);
      say("Imagem pronta.");
      return;
    }
    if (!runs.length && !dispatched) {
      // Commits from before the workflow existed have no run: build the branch head on demand.
      const head = run("git", ["rev-parse", `origin/${BRANCH}`]);
      if (head !== sha) stop(`Não há imagem para ${sha.slice(0, 7)}. Publique o commit mais recente do branch.`);
      run("gh", ["workflow", "run", WORKFLOW, "--ref", BRANCH]);
      dispatched = true;
      say("Montagem da imagem solicitada ao GitHub.");
    }
    await sleep(20000);
  }
  stop("A imagem não ficou pronta em 40 minutos.");
}

async function publishImage(environment, sha) {
  const short = sha.slice(0, 7);
  if (await liveCommit(environment.health) === short) { say(`${environment.name}: já está em ${short}.`); return; }
  say(`${environment.name}: trocando para a imagem ${short}…`);
  await railway("mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }",
    { s: SERVICE, e: environment.id, i: { source: { image: `${IMAGE}:${sha}` } } });
  await railway("mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }", { s: SERVICE, e: environment.id });
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(15000);
    if (await liveCommit(environment.health) === short) { say(`${environment.name}: no ar com ${short}.`); return; }
  }
  stop(`${environment.name}: o Railway aceitou a imagem, mas ${environment.health} não mostrou ${short} em 15 minutos. Veja os logs no painel do Railway.`);
}

async function backToGithub(sha) {
  for (const environment of ENVIRONMENTS) {
    await railway("mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }",
      { s: SERVICE, e: environment.id, i: { source: { repo: REPOSITORY } } });
    const triggers = await railway("query($p:String!,$e:String!,$s:String!){ deploymentTriggers(projectId:$p, environmentId:$e, serviceId:$s){ edges{ node{ id } } } }",
      { p: PROJECT, e: environment.id, s: SERVICE });
    if (!triggers.deploymentTriggers.edges.length) {
      await railway("mutation($i:DeploymentTriggerCreateInput!){ deploymentTriggerCreate(input:$i){ id } }",
        { i: { projectId: PROJECT, environmentId: environment.id, serviceId: SERVICE, provider: "github", repository: REPOSITORY, branch: BRANCH, checkSuites: false } });
    }
    try {
      await railway("mutation($s:String!,$e:String!,$c:String){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e, commitSha:$c) }", { s: SERVICE, e: environment.id, c: sha });
      say(`${environment.name}: de volta ao GitHub; o Railway está construindo ${sha.slice(0, 7)}.`);
    } catch (error) {
      say(`${environment.name}: de volta ao GitHub, mas o Railway recusou construir agora (${error.message}). O próximo push publica.`);
    }
  }
}

(async () => {
  const sha = run("git", ["rev-parse", "HEAD"]);
  run("git", ["fetch", "-q", "origin", BRANCH]);
  if (!run("git", ["branch", "-r", "--contains", sha]).split(/\s+/).includes(`origin/${BRANCH}`)) {
    stop(`O commit ${sha.slice(0, 7)} ainda não está no GitHub. Faça o push antes de publicar.`);
  }
  if (args.has("--voltar-github")) { await backToGithub(sha); return; }
  await waitForImage(sha);
  for (const environment of args.has("--so-staging") ? ENVIRONMENTS.slice(0, 1) : ENVIRONMENTS) await publishImage(environment, sha);
  say("Publicação concluída.");
})().catch(error => stop(error.message));
