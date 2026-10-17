#!/usr/bin/env node
"use strict";
// Restauração dos backups cifrados em R2 (gerados por services/backup.js).
//
// Variáveis: BACKUP_R2_ENDPOINT, BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID,
// BACKUP_R2_SECRET_ACCESS_KEY, BACKUP_ENCRYPTION_KEY (cópia offline).
//
// Uso:
//   node scripts/backup/restore.js list
//   node scripts/backup/restore.js download --date 2026-10-17 --out ./restore
//       baixa e decifra para arquivos locais (inspeção, sem tocar em banco)
//   node scripts/backup/restore.js firestore --date 2026-10-17 --target-project <id> [--prefix therapists/]
//       grava os documentos no projeto alvo (FIREBASE_SERVICE_ACCOUNT_JSON do ALVO)
//   node scripts/backup/restore.js storage --target-project <id> [--prefix path/]
//       recria os arquivos do Storage no bucket do projeto alvo
//
// Restaurar em produção exige --allow-production: o padrão é restaurar em
// homologação, conferir e só então decidir.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseKey, decrypt, decodeValue, backupConfig, createR2, loadManifest } = require("../../services/backup");

const PRODUCTION_PROJECTS = new Set(["osextolugar-game", "espaco-preludio-clinico"]);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const name = argv[i].slice(2);
      out[name] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(argv[i]);
  }
  return out;
}

function fail(message) { console.error(message); process.exit(1); }

async function fetchDump(r2, key, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) fail("Informe --date AAAA-MM-DD (veja `list`).");
  const dumpKey = `firestore/${date}.ndjson.gz.enc`;
  const blob = await r2.get(dumpKey);
  if (!blob) fail(`Backup ${dumpKey} não encontrado.`);
  return zlib.gunzipSync(decrypt(key, blob, dumpKey)).toString("utf8");
}

function targetApp(opts) {
  const project = opts["target-project"];
  if (!project) fail("Informe --target-project.");
  if (PRODUCTION_PROJECTS.has(project) && !opts["allow-production"]) {
    fail(`${project} é produção. Restaure primeiro em homologação; para produção use --allow-production.`);
  }
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  if (account.project_id !== project) fail("FIREBASE_SERVICE_ACCOUNT_JSON não pertence ao projeto alvo.");
  const { initializeApp, cert } = require("firebase-admin/app");
  return initializeApp({
    credential: cert({ ...account, private_key: String(account.private_key).replace(/\\n/g, "\n") }),
    storageBucket: opts["target-bucket"] || `${project}.firebasestorage.app`
  }, "restore");
}

async function main() {
  const opts = args(process.argv.slice(2));
  const command = opts._[0];
  const config = backupConfig();
  if (!config) fail("Variáveis BACKUP_* ausentes.");
  const r2 = createR2(config);
  const key = parseKey(config.encryptionKey);
  const prefix = typeof opts.prefix === "string" ? opts.prefix : "";

  if (command === "list") {
    for (const item of (await r2.list("firestore/")).sort()) console.log(item);
    const manifest = await loadManifest(r2, key);
    console.log(`storage: ${Object.keys(manifest.files).length} arquivos no manifesto`);
    return;
  }

  if (command === "download") {
    const out = path.resolve(opts.out || "./restore");
    fs.mkdirSync(out, { recursive: true });
    const ndjson = await fetchDump(r2, key, opts.date);
    fs.writeFileSync(path.join(out, `firestore-${opts.date}.ndjson`), ndjson);
    console.log(`${ndjson.split("\n").filter(Boolean).length} documentos → ${out}`);
    console.log("ATENÇÃO: contém dados clínicos decifrados. Apague a pasta após o uso.");
    return;
  }

  if (command === "firestore") {
    const ndjson = await fetchDump(r2, key, opts.date);
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(targetApp(opts));
    const writer = db.bulkWriter();
    let count = 0;
    for (const line of ndjson.split("\n")) {
      if (!line) continue;
      const { path: docPath, data } = JSON.parse(line);
      if (!docPath.startsWith(prefix)) continue;
      writer.set(db.doc(docPath), decodeValue(data, db));
      count++;
    }
    await writer.close();
    console.log(`${count} documentos restaurados em ${opts["target-project"]}.`);
    return;
  }

  if (command === "storage") {
    const { getStorage } = require("firebase-admin/storage");
    const bucket = getStorage(targetApp(opts)).bucket();
    const manifest = await loadManifest(r2, key);
    let count = 0;
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (!name.startsWith(prefix) || (entry.deletedAt && !opts["include-deleted"])) continue;
      const blob = await r2.get(entry.key);
      if (!blob) { console.warn(`faltando no R2: ${name}`); continue; }
      await bucket.file(name).save(decrypt(key, blob, entry.key), { contentType: entry.contentType || undefined, resumable: false });
      count++;
    }
    console.log(`${count} arquivos restaurados.`);
    return;
  }

  fail("Comandos: list | download | firestore | storage");
}

main().catch(error => fail(`Falhou: ${error.message}`));
