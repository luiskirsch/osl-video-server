"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { persistClinicalSignature, issuerSnapshot, profileFingerprint, prepareClinicalSignature } = require("../services/clinical-signatures");

function setup(changes = {}, docChanges = {}) {
  const profile = { displayName: "Profissional Sintético", verificationStatus: "verified", tipoConselho: "CRP", numeroConselho: "04/12345", ...changes };
  const initialProfile = { ...profile };
  const records = new Map([
    ["therapists/owner", profile], ["documents/one", { therapistUid: "owner", status: "draft", ...docChanges }]
  ]);
  const writes = [];
  const db = { collection: name => ({ doc: id => ({ key: `${name}/${id}` }) }),
    runTransaction: async callback => callback({
      get: async ref => ({ exists: records.has(ref.key), data: () => records.get(ref.key) }),
      set: (ref, value) => writes.push({ key: ref.key, value })
    }) };
  const prepared = { pdfBase64: "verified-result", signerCpf: "12345678901", verification: { valid: true, sha256: "document-hash" },
    issuerSnapshot: issuerSnapshot(initialProfile), profileFingerprint: profileFingerprint(initialProfile) };
  return { db, records, writes, prepared, ref: { key: "documents/one" } };
}

test("persist only verified PDF, frozen issuer and first certificate CPF in one transaction", async () => {
  const s = setup();
  await persistClinicalSignature(s.db, s.ref, "owner", s.prepared, { status: "signed", pdfSignedBase64: "unverified-input" });
  assert.equal(s.writes[0].value.pdfSignedBase64, "verified-result");
  assert.equal(s.writes[0].value.issuerSnapshot.displayName, "Profissional Sintético");
  assert.equal(s.writes[1].value.signatureCpf, "12345678901");
});

test("concurrent signing and another account never overwrite an issued document", async () => {
  for (const doc of [{ status: "signed" }, { therapistUid: "other" }]) {
    const s = setup({}, doc);
    await assert.rejects(persistClinicalSignature(s.db, s.ref, "owner", s.prepared, { status: "signed" }), /JA_ASSINADO|ACESSO_NEGADO/);
    assert.equal(s.writes.length, 0);
  }
});

test("CPF cannot change between verification and persistence", async () => {
  const s = setup();
  s.records.get("therapists/owner").signatureCpf = "99999999999";
  await assert.rejects(persistClinicalSignature(s.db, s.ref, "owner", s.prepared, {}), /CPF_ASSINANTE_DIVERGENTE/);
  assert.equal(s.writes.length, 0);
});

test("profile name, verification and professional scope changes invalidate in-flight signing", async () => {
  for (const change of [{ displayName: "Outra pessoa" }, { verificationStatus: "rejected" }, { tipoConselho: "CRM" }, { numeroConselho: "04/54321" }, { subtipoConselho: "to" }]) {
    const s = setup(); Object.assign(s.records.get("therapists/owner"), change);
    await assert.rejects(persistClinicalSignature(s.db, s.ref, "owner", s.prepared, {}), /PERFIL_ALTERADO/);
    assert.equal(s.writes.length, 0);
  }
});

test("actual worker rejects an unsigned PDF before persistence", async () => {
  const pdfBase64 = Buffer.from("%PDF-1.4\ninvalid unsigned document").toString("base64");
  await assert.rejects(prepareClinicalSignature({ pdfBase64, signerCpf: "12345678901", signatureMethod: "external_upload" }, { displayName: "Profissional Sintético" }), /VALIDACAO_NAO_CONCLUIDA|ASSINATURA_UNICA/);
});
