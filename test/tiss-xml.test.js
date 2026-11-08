"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const tiss = require("../services/tiss");
const { validateTissXml, worker } = require("../services/clinical-signatures");
const guide = {
  numeroGuiaPrestador: "00000001", numeroCarteira: "123456789", codigoPrestadorNaOperadora: "12345",
  cnesContratado: "1234567", nomeContratado: "Clínica & Saúde", nomeProfissional: "Profissional Sintético",
  conselhoProfissional: "CRM", numeroConselho: "12345", ufConselho: "MG", cbosProfissional: "225125",
  dataAtendimento: "2026-10-30", tussCodigo: "10101012", tussDescricao: "Consulta", valorProcedimento: 60,
};
const params = { sequencialTransacao: "123456789012", numeroLote: "123456789012", registroAnsOperadora: "123456", codigoPrestadorNaOperadora: "12345" };

test("consultation export passes the actual ANS 4.03.00 XSD", async () => {
  const result = tiss.buildLoteGuias({ ...params, guiasConsulta: [guide] });
  assert.equal((await validateTissXml(result.xml)).valid, true);
  assert.match(result.xml, /<ans:conselhoProfissional>06<\/ans:conselhoProfissional>/);
  assert.match(result.xml, /<ans:UF>31<\/ans:UF>/);
  assert.doesNotMatch(result.xml, /nomeBeneficiario/);
});

test("psychotherapy SP/SADT export passes ANS schema, with named requester and executor", async () => {
  const g = { ...guide, conselhoProfissional: "CRP", cbosProfissional: "251510", tussCodigo: "50000462", tussDescricao: "Sessão de psicoterapia", valorProcedimento: 60,
    profissionalSolicitante: { nome: "Solicitante Sintético", conselho: "CRM", numero: "54321", uf: "SP", cbos: "225125" } };
  const result = tiss.buildLoteGuias({ ...params, guiasSADT: [g] });
  assert.equal((await validateTissXml(result.xml)).valid, true);
  assert.match(result.xml, /<ans:conselho>09<\/ans:conselho>/);
  assert.match(result.xml, /<ans:valorTotalGeral>60.00<\/ans:valorTotalGeral>/);
});

test("TISS hash uses leaf VALUES and Latin-1, preserving accents and escaping", () => {
  const g = { ...guide, nomeProfissional: "José & Ana", observacao: "  Atenção\nretorno  " };
  const { xml, hash } = tiss.buildLoteGuias({ ...params, guiasConsulta: [g] });
  const time = xml.match(/<ans:horaRegistroTransacao>([^<]+)</)[1];
  const date = xml.match(/<ans:dataRegistroTransacao>([^<]+)</)[1];
  const values = "ENVIO_LOTE_GUIAS123456789012" + date + time + "123451234564.03.0012345678901212345600000001123456789N123451234567José & Ana0612345312251259052026-10-301221010101260.00  Atenção\nretorno  ";
  assert.equal(hash, crypto.createHash("md5").update(Buffer.from(values, "latin1")).digest("hex"));
});

test("schema rejects formerly accepted invalid council values and missing CNES", async () => {
  const { xml } = tiss.buildLoteGuias({ ...params, guiasConsulta: [guide] });
  await assert.rejects(validateTissXml(xml.replace("<ans:UF>31</ans:UF>", "<ans:UF>MG</ans:UF>")), /TISS_XSD_INVALIDO/);
  assert.throws(() => tiss.buildLoteGuias({ ...params, guiasConsulta: [{ ...guide, cnesContratado: "" }] }), /CNESCONTRATADO/);
  assert.throws(() => tiss.buildLoteGuias({ ...params, registroAnsOperadora: "000000", guiasConsulta: [guide] }), /REGISTRO_ANS/);
  assert.throws(() => tiss.buildLoteGuias({ ...params, guiasConsulta: Array(101).fill(guide) }), /1_A_100/);
});

test("XML validation rejects external entities and never exposes patient values in errors", async () => {
  await assert.rejects(worker({ operation: "tiss", xml: '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>' }), /XML_ENTIDADES/);
  const { xml } = tiss.buildLoteGuias({ ...params, guiasConsulta: [guide] });
  const result = await worker({ operation: "tiss", xml: xml.replace("<ans:UF>31</ans:UF>", "<ans:UF>PERSONAL-DATA</ans:UF>") });
  assert.doesNotMatch(JSON.stringify(result.issues), /PERSONAL-DATA/);
});

test("TISS dates retain explicit authorization dates and use Brasília date for session instants", () => {
  assert.equal(tiss._fmtDate("2026-10-30"), "2026-10-30");
  assert.equal(tiss._fmtDate(Date.parse("2026-10-31T01:30:00Z")), "2026-10-30");
  assert.throws(() => tiss._fmtDate("2026-02-30"), /TISS_DATA_INVALIDA/);
});
