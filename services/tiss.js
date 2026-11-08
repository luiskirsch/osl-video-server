"use strict";
const builders = require("./tiss-xml");
const { _escXml: escXml, _fmtDate: fmtDate, _fmtMoney: fmtMoney } = builders;

function buildGuiaConsultaHTML(g) {
  const guideTitle = g.tipoGuia === "sadt" ? "SP/SADT" : "Consulta";
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
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Resumo da guia ${guideTitle} TISS</title><style>${css}</style></head>
<body>
  <div class="hdr">
    <h1>RESUMO DA GUIA ${guideTitle.toUpperCase()}</h1>
    <div class="sub">Exportação TISS 4.03.00 — resumo para conferência</div>
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
    ${g.tipoGuia === "sadt" && g.profissionalSolicitante ? `<p>Solicitante: ${escXml(g.profissionalSolicitante.nome)} · ${escXml(g.profissionalSolicitante.conselho)} ${escXml(g.profissionalSolicitante.numero)} / ${escXml(g.profissionalSolicitante.uf)}</p>` : ""}
    <div class="grid-3" style="margin-top: 4px;">
      <div><span class="label">Data:</span> <span class="val">${fmtDate(g.dataAtendimento)}</span></div>
      <div><span class="label">Regime:</span> <span class="val">${escXml(g.regimeAtendimento || "05")}</span></div>
      <div><span class="label">Tipo:</span> <span class="val">${guideTitle}</span></div>
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
    Resumo para conferência; para envio à operadora, utilize o XML TISS correspondente.
  </div>
</body></html>`;
}

module.exports = { ...builders, buildGuiaConsultaHTML };
