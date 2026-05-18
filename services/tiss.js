// Espaço Prelúdio — serviço TISS (Troca de Informação em Saúde Suplementar)
// Versão alvo: TISS 4.01.00 (ANS, vigente desde 2023).
//
// Escopo Fase 2: geração de XML pra Guia de Consulta + Guia SADT, validados
// estruturalmente contra o schema da ANS (não fazemos XSD validation aqui —
// validador externo em validadortiss.com.br pode ser usado pra QA antes de
// submeter).
//
// Hash da guia (campo `epilogo > hash`): MD5 do XML sem o próprio campo
// hash, conforme manual de regras de negócio TISS componente 04.01.00.
//
// Compliance: este código NÃO assina o XML digitalmente. ANS exige A1 cert
// apenas pra submissão de lote via WebService — não pra geração local.
// Auto-submit (Fase 4+) terá módulo separado de assinatura.

const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────────────
// Helpers de XML — escapa caracteres especiais conforme XML 1.0 spec.
// Não usamos lib externa pra manter zero deps; estrutura TISS é regular.
// ─────────────────────────────────────────────────────────────────────
function escXml(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Formata data como YYYY-MM-DD (TISS usa esse formato em campos *Date).
function fmtDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Formata hora como HH:MM (TISS usa em horaInicial/horaFinal da Guia SADT).
function fmtTime(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  const h = String(dt.getUTCHours()).padStart(2, "0");
  const min = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

// Formata número decimal com 2 casas e ponto (TISS usa ponto, não vírgula).
function fmtMoney(v) {
  const n = Number(v) || 0;
  return n.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────
// Cabeçalho TISS — namespace + identificação transação.
//
// `cabecalho`:
//   - identificacaoTransacao: tipoTransacao (ENVIO_LOTE_GUIAS), sequencialTransacao,
//     dataRegistroTransacao, horaRegistroTransacao
//   - origem: prestador (identificação do prestador)
//   - destino: registroANS da operadora
//   - Padrao versao: 04.01.00
// ─────────────────────────────────────────────────────────────────────
function buildCabecalho({ sequencialTransacao, registroAnsOperadora, codigoPrestadorNaOperadora }) {
  const now = new Date();
  return `<ans:cabecalho>
  <ans:identificacaoTransacao>
    <ans:tipoTransacao>ENVIO_LOTE_GUIAS</ans:tipoTransacao>
    <ans:sequencialTransacao>${escXml(sequencialTransacao)}</ans:sequencialTransacao>
    <ans:dataRegistroTransacao>${fmtDate(now)}</ans:dataRegistroTransacao>
    <ans:horaRegistroTransacao>${fmtTime(now)}</ans:horaRegistroTransacao>
  </ans:identificacaoTransacao>
  <ans:origem>
    <ans:identificacaoPrestador>
      <ans:codigoPrestadorNaOperadora>${escXml(codigoPrestadorNaOperadora)}</ans:codigoPrestadorNaOperadora>
    </ans:identificacaoPrestador>
  </ans:origem>
  <ans:destino>
    <ans:registroANS>${escXml(registroAnsOperadora || "000000")}</ans:registroANS>
  </ans:destino>
  <ans:Padrao>04.01.00</ans:Padrao>
</ans:cabecalho>`;
}

// ─────────────────────────────────────────────────────────────────────
// Guia Consulta — usada pra consulta de psicoterapia/médica simples.
// Estrutura mínima conforme schema TISS:
//   - cabecalhoGuia (numeroGuiaPrestador, numeroGuiaOperadora?)
//   - dadosAutorizacao? (numeroGuiaOperadora, senha, dataAutorizacao, dataValidadeSenha)
//   - dadosBeneficiario (numeroCarteira, atendimentoRN, nome, ...)
//   - dadosContratado (codigoPrestadorNaOperadora, nomeContratado, CNES)
//   - dadosProfissionalExecutante (nomeProfissional, conselhoProfissional, numeroConselho, UF, CBOS)
//   - dadosAtendimento (indicacaoAcidente, indicacaoCoberturaEspecial, regimeAtendimento,
//     saudeOcupacional, tipoConsulta, dataAtendimento, procedimento)
//   - assinaturas (digital ou manual — manual = data + nome)
//
// Resultado: bloco <ans:guiaConsulta> pronto pra ser inserido num lote
// (`<ans:guiasTISS><ans:guiaConsulta>...</ans:guiaConsulta></ans:guiasTISS>`).
// ─────────────────────────────────────────────────────────────────────
function buildGuiaConsulta(g) {
  const {
    numeroGuiaPrestador,
    numeroGuiaOperadora,
    senha,
    dataAutorizacao,
    dataValidadeSenha,
    // beneficiario
    numeroCarteira,
    atendimentoRN,        // "S" ou "N"
    nomeBeneficiario,
    cnsBeneficiario,      // CNS opcional
    // contratado (prestador)
    codigoPrestadorNaOperadora,
    cnesContratado,
    nomeContratado,
    // profissional executante
    nomeProfissional,
    conselhoProfissional, // "CRP", "CRM", etc.
    numeroConselho,
    ufConselho,
    cbosProfissional,     // ex: 251510 = Psicólogo clínico
    // atendimento
    indicacaoAcidente = "9",      // 0=trabalho, 1=transito, 2=outros, 9=nao_acidente
    indicacaoCoberturaEspecial,   // opcional
    regimeAtendimento = "01",     // 01=ambulatorial
    saudeOcupacional,             // opcional
    tipoConsulta = "1",            // 1=Primeira, 2=Seguimento/Retorno, 3=Pre-natal, 4=Por encaminhamento
    dataAtendimento,
    tussCodigo,
    tussDescricao,
    valorProcedimento,
    // observacao opcional
    observacao
  } = g;

  return `<ans:guiaConsulta>
  <ans:cabecalhoGuia>
    <ans:numeroGuiaPrestador>${escXml(numeroGuiaPrestador)}</ans:numeroGuiaPrestador>${numeroGuiaOperadora ? `
    <ans:numeroGuiaOperadora>${escXml(numeroGuiaOperadora)}</ans:numeroGuiaOperadora>` : ""}
  </ans:cabecalhoGuia>${numeroGuiaOperadora || senha ? `
  <ans:dadosAutorizacao>${numeroGuiaOperadora ? `
    <ans:numeroGuiaOperadora>${escXml(numeroGuiaOperadora)}</ans:numeroGuiaOperadora>` : ""}${senha ? `
    <ans:senha>${escXml(senha)}</ans:senha>` : ""}${dataAutorizacao ? `
    <ans:dataAutorizacao>${fmtDate(dataAutorizacao)}</ans:dataAutorizacao>` : ""}${dataValidadeSenha ? `
    <ans:dataValidadeSenha>${fmtDate(dataValidadeSenha)}</ans:dataValidadeSenha>` : ""}
  </ans:dadosAutorizacao>` : ""}
  <ans:dadosBeneficiario>
    <ans:numeroCarteira>${escXml(numeroCarteira)}</ans:numeroCarteira>
    <ans:atendimentoRN>${escXml(atendimentoRN || "N")}</ans:atendimentoRN>${nomeBeneficiario ? `
    <ans:nomeBeneficiario>${escXml(nomeBeneficiario)}</ans:nomeBeneficiario>` : ""}${cnsBeneficiario ? `
    <ans:numeroCNS>${escXml(cnsBeneficiario)}</ans:numeroCNS>` : ""}
  </ans:dadosBeneficiario>
  <ans:dadosContratado>
    <ans:codigoPrestadorNaOperadora>${escXml(codigoPrestadorNaOperadora)}</ans:codigoPrestadorNaOperadora>${cnesContratado ? `
    <ans:CNES>${escXml(cnesContratado)}</ans:CNES>` : ""}
    <ans:nomeContratado>${escXml(nomeContratado)}</ans:nomeContratado>
  </ans:dadosContratado>
  <ans:dadosProfissionalExecutante>
    <ans:nomeProfissional>${escXml(nomeProfissional)}</ans:nomeProfissional>
    <ans:conselhoProfissional>${escXml(conselhoProfissional)}</ans:conselhoProfissional>
    <ans:numeroConselhoProfissional>${escXml(numeroConselho)}</ans:numeroConselhoProfissional>
    <ans:UF>${escXml(ufConselho)}</ans:UF>
    <ans:CBOS>${escXml(cbosProfissional || "")}</ans:CBOS>
  </ans:dadosProfissionalExecutante>
  <ans:dadosAtendimento>
    <ans:indicacaoAcidente>${escXml(indicacaoAcidente)}</ans:indicacaoAcidente>${indicacaoCoberturaEspecial ? `
    <ans:indicacaoCoberturaEspecial>${escXml(indicacaoCoberturaEspecial)}</ans:indicacaoCoberturaEspecial>` : ""}
    <ans:regimeAtendimento>${escXml(regimeAtendimento)}</ans:regimeAtendimento>${saudeOcupacional ? `
    <ans:saudeOcupacional>${escXml(saudeOcupacional)}</ans:saudeOcupacional>` : ""}
    <ans:tipoConsulta>${escXml(tipoConsulta)}</ans:tipoConsulta>
    <ans:dataAtendimento>${fmtDate(dataAtendimento)}</ans:dataAtendimento>
    <ans:procedimento>
      <ans:codigoTabela>22</ans:codigoTabela>
      <ans:codigoProcedimento>${escXml(tussCodigo)}</ans:codigoProcedimento>
      <ans:descricaoProcedimento>${escXml(tussDescricao || "")}</ans:descricaoProcedimento>
      <ans:valorProcedimento>${fmtMoney(valorProcedimento)}</ans:valorProcedimento>
    </ans:procedimento>${observacao ? `
    <ans:observacao>${escXml(observacao)}</ans:observacao>` : ""}
  </ans:dadosAtendimento>
</ans:guiaConsulta>`;
}

// ─────────────────────────────────────────────────────────────────────
// Guia SADT — Serviço Auxiliar de Diagnóstico e Terapia.
// Usada pra avaliação psicológica, testes, neuropsicologia, fisioterapia.
// Diferenças vs Consulta: dadosSolicitante + dadosSolicitacao + procedimentos
// MÚLTIPLOS (não só um), com hora inicial/final.
// ─────────────────────────────────────────────────────────────────────
function buildGuiaSADT(g) {
  const {
    numeroGuiaPrestador,
    numeroGuiaOperadora,
    senha,
    dataAutorizacao,
    dataValidadeSenha,
    // beneficiario (igual consulta)
    numeroCarteira,
    atendimentoRN,
    nomeBeneficiario,
    // solicitante
    nomeContratadoSolicitante,
    codigoPrestadorSolicitanteNaOperadora,
    nomeProfissionalSolicitante,
    conselhoSolicitante,
    numeroConselhoSolicitante,
    ufSolicitante,
    cbosSolicitante,
    // contratado executante
    codigoPrestadorNaOperadora,
    cnesContratado,
    nomeContratado,
    // dadosAtendimento SADT
    dataSolicitacao,
    caraterAtendimento = "1",   // 1=eletivo, 2=urgencia
    tipoAtendimento = "05",      // 05=consulta_psicoterapia
    indicacaoAcidente = "9",
    tipoConsulta = "1",
    indicacaoClinica,            // texto livre
    // procedimentos (array)
    procedimentos = [],          // [{tussCodigo, tussDescricao, quantidade, valorUnitario}]
    // execucao
    dataInicio,
    horaInicio,
    horaFim,
    profissionalExecutante = {}  // {nome, conselho, numero, uf, cbos}
  } = g;

  const procXml = procedimentos.map((p, idx) => `
    <ans:procedimentosExecutados>
      <ans:procedimento>
        <ans:codigoTabela>22</ans:codigoTabela>
        <ans:codigoProcedimento>${escXml(p.tussCodigo)}</ans:codigoProcedimento>
        <ans:descricaoProcedimento>${escXml(p.tussDescricao || "")}</ans:descricaoProcedimento>
      </ans:procedimento>
      <ans:quantidadeExecutada>${escXml(p.quantidade || 1)}</ans:quantidadeExecutada>
      <ans:viaAcesso>U</ans:viaAcesso>
      <ans:tecnicaUtilizada>0</ans:tecnicaUtilizada>
      <ans:valorUnitario>${fmtMoney(p.valorUnitario || 0)}</ans:valorUnitario>
      <ans:valorTotal>${fmtMoney((p.valorUnitario || 0) * (p.quantidade || 1))}</ans:valorTotal>
    </ans:procedimentosExecutados>`).join("");

  return `<ans:guiaSP-SADT>
  <ans:cabecalhoGuia>
    <ans:numeroGuiaPrestador>${escXml(numeroGuiaPrestador)}</ans:numeroGuiaPrestador>${numeroGuiaOperadora ? `
    <ans:numeroGuiaOperadora>${escXml(numeroGuiaOperadora)}</ans:numeroGuiaOperadora>` : ""}
  </ans:cabecalhoGuia>${numeroGuiaOperadora || senha ? `
  <ans:dadosAutorizacao>${numeroGuiaOperadora ? `
    <ans:numeroGuiaOperadora>${escXml(numeroGuiaOperadora)}</ans:numeroGuiaOperadora>` : ""}${senha ? `
    <ans:senha>${escXml(senha)}</ans:senha>` : ""}${dataAutorizacao ? `
    <ans:dataAutorizacao>${fmtDate(dataAutorizacao)}</ans:dataAutorizacao>` : ""}${dataValidadeSenha ? `
    <ans:dataValidadeSenha>${fmtDate(dataValidadeSenha)}</ans:dataValidadeSenha>` : ""}
  </ans:dadosAutorizacao>` : ""}
  <ans:dadosBeneficiario>
    <ans:numeroCarteira>${escXml(numeroCarteira)}</ans:numeroCarteira>
    <ans:atendimentoRN>${escXml(atendimentoRN || "N")}</ans:atendimentoRN>${nomeBeneficiario ? `
    <ans:nomeBeneficiario>${escXml(nomeBeneficiario)}</ans:nomeBeneficiario>` : ""}
  </ans:dadosBeneficiario>
  <ans:dadosSolicitante>
    <ans:contratadoSolicitante>
      <ans:codigoPrestadorNaOperadora>${escXml(codigoPrestadorSolicitanteNaOperadora || codigoPrestadorNaOperadora)}</ans:codigoPrestadorNaOperadora>
      <ans:nomeContratado>${escXml(nomeContratadoSolicitante || nomeContratado)}</ans:nomeContratado>
    </ans:contratadoSolicitante>
    <ans:profissionalSolicitante>
      <ans:nomeProfissional>${escXml(nomeProfissionalSolicitante || profissionalExecutante.nome)}</ans:nomeProfissional>
      <ans:conselhoProfissional>${escXml(conselhoSolicitante || profissionalExecutante.conselho)}</ans:conselhoProfissional>
      <ans:numeroConselhoProfissional>${escXml(numeroConselhoSolicitante || profissionalExecutante.numero)}</ans:numeroConselhoProfissional>
      <ans:UF>${escXml(ufSolicitante || profissionalExecutante.uf)}</ans:UF>
      <ans:CBOS>${escXml(cbosSolicitante || profissionalExecutante.cbos || "")}</ans:CBOS>
    </ans:profissionalSolicitante>
  </ans:dadosSolicitante>
  <ans:dadosSolicitacao>
    <ans:dataSolicitacao>${fmtDate(dataSolicitacao || dataInicio)}</ans:dataSolicitacao>
    <ans:caraterAtendimento>${escXml(caraterAtendimento)}</ans:caraterAtendimento>${indicacaoClinica ? `
    <ans:indicacaoClinica>${escXml(indicacaoClinica)}</ans:indicacaoClinica>` : ""}
  </ans:dadosSolicitacao>
  <ans:dadosExecutante>
    <ans:contratadoExecutante>
      <ans:codigoPrestadorNaOperadora>${escXml(codigoPrestadorNaOperadora)}</ans:codigoPrestadorNaOperadora>${cnesContratado ? `
      <ans:CNES>${escXml(cnesContratado)}</ans:CNES>` : ""}
      <ans:nomeContratado>${escXml(nomeContratado)}</ans:nomeContratado>
    </ans:contratadoExecutante>
  </ans:dadosExecutante>
  <ans:dadosAtendimento>
    <ans:tipoAtendimento>${escXml(tipoAtendimento)}</ans:tipoAtendimento>
    <ans:indicacaoAcidente>${escXml(indicacaoAcidente)}</ans:indicacaoAcidente>
    <ans:tipoConsulta>${escXml(tipoConsulta)}</ans:tipoConsulta>
    <ans:dataInicioFaturamento>${fmtDate(dataInicio)}</ans:dataInicioFaturamento>${horaInicio ? `
    <ans:horaInicial>${escXml(horaInicio)}</ans:horaInicial>` : ""}${horaFim ? `
    <ans:horaFinal>${escXml(horaFim)}</ans:horaFinal>` : ""}
  </ans:dadosAtendimento>${procXml}
</ans:guiaSP-SADT>`;
}

// ─────────────────────────────────────────────────────────────────────
// Lote (mensagemTISS) — empacota cabecalho + N guias + epilogo (hash MD5).
//
// Hash: MD5 do XML SEM o elemento <hash> nem espaços em branco entre tags.
// Algoritmo:
//   1. Monta XML inteiro com <hash></hash> vazio.
//   2. Remove whitespace entre tags (replace />\s+</g, "><").
//   3. Remove o próprio <hash></hash> da string.
//   4. MD5 do resultado.
//   5. Insere hash no XML final.
// ─────────────────────────────────────────────────────────────────────
function buildLoteGuias({
  sequencialTransacao,
  numeroLote,
  registroAnsOperadora,
  codigoPrestadorNaOperadora,
  guiasConsulta = [],
  guiasSADT = []
}) {
  const cabecalho = buildCabecalho({ sequencialTransacao, registroAnsOperadora, codigoPrestadorNaOperadora });
  const guiasXml = [
    ...guiasConsulta.map(g => buildGuiaConsulta(g)),
    ...guiasSADT.map(g => buildGuiaSADT(g))
  ].join("");

  const inner = `<ans:prestadorParaOperadora>
  ${cabecalho}
  <ans:prestadorParaOperadora>
    <ans:loteGuias>
      <ans:numeroLote>${escXml(numeroLote)}</ans:numeroLote>
      <ans:guiasTISS>
        ${guiasXml}
      </ans:guiasTISS>
    </ans:loteGuias>
  </ans:prestadorParaOperadora>
  <ans:epilogo>
    <ans:hash>__HASH_PLACEHOLDER__</ans:hash>
  </ans:epilogo>
</ans:prestadorParaOperadora>`;

  // Calcula hash MD5 do XML sem o hash em si (mas com a tag vazia).
  const semHash = inner.replace(/<ans:hash>__HASH_PLACEHOLDER__<\/ans:hash>/, "");
  const normalized = semHash.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  const hash = crypto.createHash("md5").update(normalized).digest("hex");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ans:mensagemTISS xmlns:ans="http://www.ans.gov.br/padroes/tiss/schemas" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.ans.gov.br/padroes/tiss/schemas http://www.ans.gov.br/padroes/tiss/schemas/tissV4_01_00.xsd">
  ${inner.replace("__HASH_PLACEHOLDER__", hash)}
</ans:mensagemTISS>`;

  return { xml, hash, totalGuias: guiasConsulta.length + guiasSADT.length };
}

// ─────────────────────────────────────────────────────────────────────
// PDF da guia — geração via HTML+CSS standard, usado pela ANS em sistemas
// que aceitam upload de PDF da guia preenchida. Modelo simplificado:
// não é o formulário oficial 4-vias da ANS (que precisa de gabarito), mas
// formato compatível pra arquivamento e envio por email pro convênio
// quando o convênio não aceita XML direto.
//
// Retorna HTML que pode ser convertido em PDF via puppeteer / @react-pdf
// no consumidor. Stub aqui devolve HTML — frontend pode imprimir como PDF
// via window.print(), ou backend usa lib pdf-lib se precisar PDF binário.
// ─────────────────────────────────────────────────────────────────────
function buildGuiaConsultaHTML(g) {
  const css = `
    body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #000; }
    .hdr { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 10px; }
    .hdr h1 { margin: 0; font-size: 14px; }
    .hdr .sub { font-size: 10px; color: #444; }
    .box { border: 1px solid #888; padding: 6px 10px; margin-bottom: 8px; }
    .box .label { font-weight: bold; font-size: 9px; text-transform: uppercase; color: #444; letter-spacing: 0.04em; }
    .box .val { font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .ftr { margin-top: 30px; padding-top: 10px; border-top: 1px solid #ccc; font-size: 9px; color: #666; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    th, td { border: 1px solid #888; padding: 4px 6px; font-size: 11px; text-align: left; }
    th { background: #eee; }
  `;

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Guia de Consulta TISS</title><style>${css}</style></head>
<body>
  <div class="hdr">
    <h1>GUIA DE CONSULTA</h1>
    <div class="sub">Padrão TISS 4.01.00 — ANS</div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="label">Nº Guia Prestador</div>
      <div class="val">${escXml(g.numeroGuiaPrestador)}</div>
    </div>
    <div class="box">
      <div class="label">Nº Guia Operadora</div>
      <div class="val">${escXml(g.numeroGuiaOperadora || "—")}</div>
    </div>
  </div>

  <div class="box">
    <div class="label">Beneficiário</div>
    <div class="val">${escXml(g.nomeBeneficiario || "—")}</div>
    <div class="grid" style="margin-top: 4px;">
      <div><span class="label">Carteira:</span> <span class="val">${escXml(g.numeroCarteira)}</span></div>
      <div><span class="label">Atend. RN:</span> <span class="val">${escXml(g.atendimentoRN || "N")}</span></div>
    </div>
  </div>

  <div class="box">
    <div class="label">Contratado (Prestador)</div>
    <div class="val">${escXml(g.nomeContratado)}</div>
    <div class="grid" style="margin-top: 4px;">
      <div><span class="label">Cód. na Operadora:</span> <span class="val">${escXml(g.codigoPrestadorNaOperadora)}</span></div>
      <div><span class="label">CNES:</span> <span class="val">${escXml(g.cnesContratado || "—")}</span></div>
    </div>
  </div>

  <div class="box">
    <div class="label">Profissional Executante</div>
    <div class="val">${escXml(g.nomeProfissional)}</div>
    <div class="grid-3" style="margin-top: 4px;">
      <div><span class="label">${escXml(g.conselhoProfissional)}:</span> <span class="val">${escXml(g.numeroConselho)}</span></div>
      <div><span class="label">UF:</span> <span class="val">${escXml(g.ufConselho)}</span></div>
      <div><span class="label">CBOS:</span> <span class="val">${escXml(g.cbosProfissional || "—")}</span></div>
    </div>
  </div>

  <div class="box">
    <div class="label">Atendimento</div>
    <div class="grid-3" style="margin-top: 4px;">
      <div><span class="label">Data:</span> <span class="val">${fmtDate(g.dataAtendimento)}</span></div>
      <div><span class="label">Regime:</span> <span class="val">${escXml(g.regimeAtendimento || "01")}</span></div>
      <div><span class="label">Tipo Consulta:</span> <span class="val">${escXml(g.tipoConsulta || "1")}</span></div>
    </div>
    <table style="margin-top: 8px;">
      <thead><tr><th>Tabela</th><th>Cód. TUSS</th><th>Descrição</th><th style="text-align: right;">Valor (R$)</th></tr></thead>
      <tbody>
        <tr>
          <td>22</td>
          <td>${escXml(g.tussCodigo)}</td>
          <td>${escXml(g.tussDescricao || "")}</td>
          <td style="text-align: right;">${fmtMoney(g.valorProcedimento)}</td>
        </tr>
      </tbody>
    </table>
    ${g.observacao ? `<div class="label" style="margin-top: 6px;">Observação:</div><div class="val">${escXml(g.observacao)}</div>` : ""}
  </div>

  <div class="ftr">
    Gerado em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} pelo Espaço Prelúdio.
    Documento gerado conforme padrão TISS 4.01.00 da ANS. Para validação oficial,
    envie o XML correspondente ao convênio.
  </div>
</body></html>`;
}

module.exports = {
  buildCabecalho,
  buildGuiaConsulta,
  buildGuiaSADT,
  buildLoteGuias,
  buildGuiaConsultaHTML,
  // helpers expostos pra testes / outros usos
  _escXml: escXml,
  _fmtDate: fmtDate,
  _fmtMoney: fmtMoney
};
