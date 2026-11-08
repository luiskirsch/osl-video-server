"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
let running = 0;

function worker(payload) {
  if (running >= 3) return Promise.reject(Object.assign(new Error("VALIDADOR_OCUPADO"), { status: 503 }));
  running++;
  const local = path.join(__dirname, "../.venv-validation", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.VALIDATION_PYTHON || (fs.existsSync(local) ? local : "python3");
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", path.join(__dirname, "validation_worker.py")],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "", finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); running--;
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error("VALIDACAO_INDISPONIVEL"), { status: 503 })); }, 60_000);
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      if (output.length > 9_000_000) { child.kill(); finish(new Error("VALIDACAO_RESPOSTA_INVALIDA")); }
    });
    child.on("error", () => finish(Object.assign(new Error("VALIDACAO_INDISPONIVEL"), { status: 503 })));
    child.stdin.on("error", () => {});
    child.on("close", code => {
      if (finished) return;
      try {
        const result = JSON.parse(output);
        if (code !== 0 || !result.ok) return finish(Object.assign(new Error(result.error || "VALIDACAO_INDISPONIVEL"), { status: code ? 503 : 422 }));
        finish(null, result);
      } catch { finish(Object.assign(new Error("VALIDACAO_INDISPONIVEL"), { status: 503 })); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function prepareClinicalSignature(body, therapist) {
  if (!String(therapist.displayName || "").trim()) throw Object.assign(new Error("NOME_ASSINANTE_DIVERGENTE"), { status: 422 });
  const cpf = String(therapist.signatureCpf || therapist.cpf || therapist.consultorio?.cpf || body.signerCpf || "").replace(/\D/g, "");
  if (cpf.length !== 11) throw Object.assign(new Error("CPF_PROFISSIONAL_OBRIGATORIO"), { status: 422 });
  const operation = body.signatureMethod === "a1_server" ? "sign" : "verify";
  const result = await worker({ operation, cpf, expectedName: therapist.displayName, pdfBase64: body.pdfBase64,
    ...(operation === "sign" ? { certPfxBase64: body.certPfxBase64, certPassword: body.certPassword } : {}) });
  const pdfBase64 = result.pdfBase64 || body.pdfBase64;
  // Firestore documents have a 1 MiB limit, including encrypted form data.
  if (pdfBase64.length > 850_000) throw Object.assign(new Error("PDF_GRANDE_DEMAIS"), { status: 413 });
  return { pdfBase64, verification: result.verification, signerCpf: cpf,
    issuerSnapshot: issuerSnapshot(therapist), profileFingerprint: profileFingerprint(therapist) };
}

function issuerSnapshot(profile) {
  return Object.fromEntries(["displayName", "crm", "crp", "rqe", "especialidade", "consultorio"]
    .map(key => [key, profile[key] ?? (key === "consultorio" ? null : "")]));
}

function profileFingerprint(profile) {
  return JSON.stringify([issuerSnapshot(profile), ...["verificationStatus", "conselho", "conselhoSigla", "registroProfissional",
    "tipoConselho", "subtipoConselho", "numeroConselho", "tipoProfissional", "crefito", "crn", "cro", "intendedTier", "plano"].map(key => profile[key] ?? null)]);
}

async function validateTissXml(xml) {
  const result = await worker({ operation: "tiss", xml });
  if (!result.valid) throw Object.assign(new Error("TISS_XSD_INVALIDO"), { status: 422, issues: result.issues });
  return result;
}

async function persistClinicalSignature(db, ref, uid, prepared, patch) {
  const profileRef = db.collection("therapists").doc(uid);
  return db.runTransaction(async tx => {
    const [doc, profile] = await Promise.all([tx.get(ref), tx.get(profileRef)]);
    if (!doc.exists || doc.data().therapistUid !== uid) throw Object.assign(new Error("ACESSO_NEGADO"), { status: 403 });
    if (doc.data().status !== "draft") throw Object.assign(new Error("DOCUMENTO_JA_ASSINADO"), { status: 409 });
    if (!profile.exists) throw Object.assign(new Error("PROFISSIONAL_NAO_REGISTRADO"), { status: 403 });
    const existingCpf = profile.data().signatureCpf || profile.data().cpf || profile.data().consultorio?.cpf;
    if (existingCpf && String(existingCpf).replace(/\D/g, "") !== prepared.signerCpf) {
      throw Object.assign(new Error("CPF_ASSINANTE_DIVERGENTE"), { status: 409 });
    }
    if (profileFingerprint(profile.data()) !== prepared.profileFingerprint) {
      throw Object.assign(new Error("PERFIL_ALTERADO_DURANTE_ASSINATURA"), { status: 409 });
    }
    tx.set(ref, { ...patch, pdfSignedBase64: prepared.pdfBase64,
      signatureVerification: prepared.verification, issuerSnapshot: prepared.issuerSnapshot }, { merge: true });
    if (!profile.data().signatureCpf) tx.set(profileRef, { signatureCpf: prepared.signerCpf }, { merge: true });
  });
}
module.exports = { worker, prepareClinicalSignature, persistClinicalSignature, validateTissXml, issuerSnapshot, profileFingerprint };
