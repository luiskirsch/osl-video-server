"use strict";
const crypto = require("node:crypto");
const VERSION = "4.03.00";
const NS = "http://www.ans.gov.br/padroes/tiss/schemas";
const COUNCILS = { CRESS: "01", COREN: "02", CRF: "03", CRFA: "04", CREFITO: "05", CRM: "06", CRN: "07", CRO: "08", CRP: "09", CREF: "13" };
const UF = { RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50", MT: "51", GO: "52", DF: "53" };
function error(code) { throw Object.assign(new Error(code), { status: 422 }); }
function escXml(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
const tag = (key, value) => `<ans:${key}>${escXml(value)}</ans:${key}>`;
const block = (key, value) => `<ans:${key}>${value}</ans:${key}>`;
const optional = (key, value) => value == null || value === "" ? "" : tag(key, value);
function fmtDate(value) {
  if (!value) return error("TISS_DATA_OBRIGATORIA");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) error("TISS_DATA_INVALIDA");
    return value;
  }
  const date = new Date(value?.toMillis ? value.toMillis() : value);
  if (!Number.isFinite(date.getTime())) return error("TISS_DATA_INVALIDA");
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function fmtMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return error("TISS_VALOR_INVALIDO");
  return number.toFixed(2);
}
function number12(value) {
  if (!/^\d{1,12}$/.test(String(value))) return error("TISS_SEQUENCIAL_INVALIDO");
  return String(value);
}
function requireGuide(g) {
  for (const key of ["registroAnsOperadora", "numeroGuiaPrestador", "numeroCarteira", "codigoPrestadorNaOperadora", "cnesContratado"])
    if (!g[key] || String(g[key]) === "000000") error("TISS_CAMPO_OBRIGATORIO_" + key.toUpperCase());
}
function buildCabecalho({ sequencialTransacao, registroAnsOperadora, codigoPrestadorNaOperadora }) {
  if (!/^\d{6}$/.test(registroAnsOperadora || "") || registroAnsOperadora === "000000") error("TISS_REGISTRO_ANS_INVALIDO");
  const now = new Date();
  return block("cabecalho", block("identificacaoTransacao", tag("tipoTransacao", "ENVIO_LOTE_GUIAS") +
    tag("sequencialTransacao", number12(sequencialTransacao)) + tag("dataRegistroTransacao", fmtDate(now)) + tag("horaRegistroTransacao", new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now))) +
    block("origem", block("identificacaoPrestador", tag("codigoPrestadorNaOperadora", codigoPrestadorNaOperadora))) +
    block("destino", tag("registroANS", registroAnsOperadora)) + tag("Padrao", VERSION));
}
function cabecalhoGuia(g, key) { return block(key, tag("registroANS", g.registroAnsOperadora) + tag("numeroGuiaPrestador", g.numeroGuiaPrestador)); }
function beneficiary(g) { return block("dadosBeneficiario", tag("numeroCarteira", g.numeroCarteira) + tag("atendimentoRN", g.atendimentoRN || "N")); }
function professional(p, key) {
  const council = String(p.conselho || p.conselhoProfissional || "").toUpperCase();
  const uf = String(p.uf || p.ufConselho || "").toUpperCase();
  return block(key, optional("nomeProfissional", p.nome || p.nomeProfissional) +
    tag("conselhoProfissional", COUNCILS[council] || council) +
    tag("numeroConselhoProfissional", p.numero || p.numeroConselho) + tag("UF", UF[uf] || uf) + tag("CBOS", p.cbos || p.cbosProfissional));
}
function buildGuiaConsulta(g) {
  requireGuide(g);
  return block("guiaConsulta", cabecalhoGuia(g, "cabecalhoConsulta") + optional("numeroGuiaOperadora", g.numeroGuiaOperadora) +
    beneficiary(g) + block("contratadoExecutante", tag("codigoPrestadorNaOperadora", g.codigoPrestadorNaOperadora) + tag("CNES", g.cnesContratado)) +
    professional(g, "profissionalExecutante") + tag("indicacaoAcidente", g.indicacaoAcidente || "9") +
    block("dadosAtendimento", optional("coberturaEspecial", g.indicacaoCoberturaEspecial) + tag("regimeAtendimento", g.regimeAtendimento || "05") +
      optional("saudeOcupacional", g.saudeOcupacional) + tag("dataAtendimento", fmtDate(g.dataAtendimento)) + tag("tipoConsulta", g.tipoConsulta || "1") +
      block("procedimento", tag("codigoTabela", "22") + tag("codigoProcedimento", g.tussCodigo) + tag("valorProcedimento", fmtMoney(g.valorProcedimento)))) + optional("observacao", g.observacao));
}
function buildGuiaSADT(g) {
  requireGuide(g);
  const p = g.profissionalExecutante || g;
  const procedures = g.procedimentos || [{ tussCodigo: g.tussCodigo, tussDescricao: g.tussDescricao, quantidade: 1, valorUnitario: g.valorProcedimento }];
  if (!procedures.length) error("TISS_PROCEDIMENTO_OBRIGATORIO");
  let centsTotal = 0;
  const executed = procedures.map((item, i) => {
    const quantity = Number(item.quantidade ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) error("TISS_QUANTIDADE_INVALIDA");
    const cents = Math.round(Number(fmtMoney(item.valorUnitario)) * 100);
    centsTotal += cents * quantity;
    const council = String(p.conselho || p.conselhoProfissional || "").toUpperCase();
    const uf = String(p.uf || p.ufConselho || "").toUpperCase();
    return block("procedimentoExecutado", tag("sequencialItem", i + 1) + tag("dataExecucao", fmtDate(g.dataInicio || g.dataAtendimento)) +
      optional("horaInicial", g.horaInicio) + optional("horaFinal", g.horaFim) +
      block("procedimento", tag("codigoTabela", "22") + tag("codigoProcedimento", item.tussCodigo) + tag("descricaoProcedimento", item.tussDescricao)) +
      tag("quantidadeExecutada", quantity) + tag("reducaoAcrescimo", "1.00") + tag("valorUnitario", fmtMoney(cents / 100)) + tag("valorTotal", fmtMoney(cents * quantity / 100)) +
      block("equipeSadt", block("codProfissional", tag("codigoPrestadorNaOperadora", g.codigoPrestadorNaOperadora)) +
        tag("nomeProf", p.nome || p.nomeProfissional) + tag("conselho", COUNCILS[council] || council) +
        tag("numeroConselhoProfissional", p.numero || p.numeroConselho) + tag("UF", UF[uf] || uf) + tag("CBOS", p.cbos || p.cbosProfissional)));
  }).join("");
  const auth = g.dataAutorizacao ? block("dadosAutorizacao", optional("numeroGuiaOperadora", g.numeroGuiaOperadora) +
    tag("dataAutorizacao", fmtDate(g.dataAutorizacao)) + optional("senha", g.senha) + (g.dataValidadeSenha ? tag("dataValidadeSenha", fmtDate(g.dataValidadeSenha)) : "")) : "";
  if ((g.senha || g.numeroGuiaOperadora) && !g.dataAutorizacao) error("TISS_DATA_AUTORIZACAO_OBRIGATORIA");
  return block("guiaSP-SADT", cabecalhoGuia(g, "cabecalhoGuia") + auth + beneficiary(g) +
    block("dadosSolicitante", block("contratadoSolicitante", tag("codigoPrestadorNaOperadora", g.codigoPrestadorSolicitanteNaOperadora || g.codigoPrestadorNaOperadora)) +
      tag("nomeContratadoSolicitante", g.nomeContratadoSolicitante || g.nomeContratado) + professional(g.profissionalSolicitante || p, "profissionalSolicitante")) +
    block("dadosSolicitacao", tag("dataSolicitacao", fmtDate(g.dataSolicitacao || g.dataAtendimento || g.dataInicio)) + tag("caraterAtendimento", g.caraterAtendimento || "1") + optional("indicacaoClinica", g.indicacaoClinica)) +
    block("dadosExecutante", block("contratadoExecutante", tag("codigoPrestadorNaOperadora", g.codigoPrestadorNaOperadora)) + tag("CNES", g.cnesContratado)) +
    block("dadosAtendimento", tag("tipoAtendimento", g.tipoAtendimento || "03") + tag("indicacaoAcidente", g.indicacaoAcidente || "9") + tag("regimeAtendimento", g.regimeAtendimento || "05")) +
    block("procedimentosExecutados", executed) + optional("observacao", g.observacao) +
    block("valorTotal", tag("valorProcedimentos", fmtMoney(centsTotal / 100)) + tag("valorTotalGeral", fmtMoney(centsTotal / 100))));
}
function buildLoteGuias({ sequencialTransacao, numeroLote, registroAnsOperadora, codigoPrestadorNaOperadora, guiasConsulta = [], guiasSADT = [] }) {
  const totalGuias = guiasConsulta.length + guiasSADT.length;
  if (!totalGuias || totalGuias > 100) error("TISS_LOTE_DEVE_CONTER_1_A_100_GUIAS");
  if (guiasConsulta.length && guiasSADT.length) error("TISS_LOTE_TIPOS_DIFERENTES");
  number12(numeroLote);
  const head = buildCabecalho({ sequencialTransacao, registroAnsOperadora, codigoPrestadorNaOperadora });
  const guides = [...guiasConsulta.map(g => buildGuiaConsulta({ ...g, registroAnsOperadora })), ...guiasSADT.map(g => buildGuiaSADT({ ...g, registroAnsOperadora }))].join("");
  const body = block("prestadorParaOperadora", block("loteGuias", tag("numeroLote", numeroLote) + block("guiasTISS", guides)));
  // ANS: concatenated element VALUES, exactly as represented, encoded ISO-8859-1.
  const values = (head + body).replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);
  if ([...values].some(char => char.codePointAt(0) > 255)) error("TISS_CARACTERE_FORA_ISO_8859_1");
  const hash = crypto.createHash("md5").update(Buffer.from(values, "latin1")).digest("hex");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ans:mensagemTISS xmlns:ans="${NS}">${head}${body}${block("epilogo", tag("hash", hash))}</ans:mensagemTISS>`;
  return { xml, hash, totalGuias, version: VERSION };
}
module.exports = { VERSION, buildCabecalho, buildGuiaConsulta, buildGuiaSADT, buildLoteGuias, _escXml: escXml, _fmtDate: fmtDate, _fmtMoney: fmtMoney };
