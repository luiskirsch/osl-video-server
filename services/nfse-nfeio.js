// NFS-e via NFE.io — adapter sobre api.nfe.io.
//
// Por que NFE.io e não SOAP direto: cada município tem webservice próprio
// (Florianópolis usa GINFES, São Paulo é próprio, ABRASF varia por versão),
// XAdES-BES com SHA-1 + manuseio de certificado A1 .pfx. NFE.io abstrai
// tudo isso por uma REST API única que cobre os ~5.500 municípios.
//
// Custo (consumidor final, não nosso): ~R$ 0,15-0,40 por nota emitida.
// O profissional paga direto pra NFE.io — a gente só intermedia.
//
// Fluxo:
//   1. User configura companyId + apiToken no perfil (token cifrado com DEK).
//   2. Pra emitir, frontend POSTa /therapy/nfse/emitir com DEK (Authorization
//      header não basta — precisa do DEK pra decifrar o apiToken).
//   3. Backend decifra token client-side-ish (DEK passa no header), monta
//      payload NFE.io, POSTa, persiste resposta no recibo.
//   4. Webhook NFE.io atualiza status (Authorized / Cancelled / Error) e
//      grava a URL pública do PDF.

const NFEIO_BASE_URLS = {
  production: "https://api.nfe.io/v1",
  sandbox:    "https://api.nfe.io/v1"
  // NFE.io não tem URL separada de sandbox — usa "environment" no payload.
  // Production vs Sandbox vira flag no body, mesma URL.
};

async function nfeIoFetch({ apiToken, path, method = "GET", body = null }) {
  const url = `${NFEIO_BASE_URLS.production}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": apiToken,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* não-JSON */ }
  if (!res.ok) {
    const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

// Testa conexão buscando dados da empresa. Útil pra validar o token+companyId
// sem emitir nota.
async function testConnection({ apiToken, companyId, environment }) {
  if (!apiToken) throw new Error("NFSE_TOKEN_AUSENTE");
  if (!companyId) throw new Error("NFSE_COMPANY_AUSENTE");
  const data = await nfeIoFetch({
    apiToken,
    path: `/companies/${encodeURIComponent(companyId)}`
  });
  return {
    ok: true,
    companyId,
    companyName: data?.name || data?.federalTaxNumber || null,
    environment: environment || "sandbox"
  };
}

// Emite uma NFS-e a partir de um recibo. Retorna o ID NFE.io + status inicial.
// O status final (Authorized / Cancelled / Error) vem via webhook ou polling.
async function emitirNfse({ apiToken, companyId, environment, receipt, therapist, borrower }) {
  if (!apiToken) throw new Error("NFSE_TOKEN_AUSENTE");
  if (!companyId) throw new Error("NFSE_COMPANY_AUSENTE");
  if (!receipt) throw new Error("RECIBO_AUSENTE");

  const nfse = therapist.nfseConfig || {};
  if (!nfse.codServicoMunicipal) throw new Error("CODIGO_SERVICO_AUSENTE");
  if (nfse.aliquotaIss == null)  throw new Error("ALIQUOTA_AUSENTE");

  // Payload NFE.io v1 ServiceInvoice. Campos mínimos:
  //   - cityServiceCode: código municipal
  //   - description: descrição do serviço (vai no corpo da nota)
  //   - servicesAmount: valor em reais (decimal)
  //   - issRate: alíquota em %, ou taxationType pra ISS retido
  //   - borrower: tomador (paciente)
  //   - environment: "Production" | "Development" (sandbox)
  const amountReais = Number((receipt.amount / 100).toFixed(2));
  const issRate = Number(nfse.aliquotaIss);

  const payload = {
    cityServiceCode: nfse.codServicoMunicipal,
    description: receipt.description || `Atendimento ${therapist.especialidade || "profissional"} · Recibo nº ${receipt.sequentialNumber}`,
    servicesAmount: amountReais,
    issRate: issRate,
    environment: environment === "production" ? "Production" : "Development",
    borrower: {
      // Tomador: paciente. NFE.io aceita pessoa física com CPF, ou genérico.
      // Como nosso paciente é cifrado E2EE, só temos o nome — sem CPF/endereço
      // estruturado por padrão. Se o user passar borrower customizado (do
      // frontend, decifrado client-side), preenche; senão tomador genérico.
      name: borrower?.name || receipt.patientName || "Consumidor Final",
      email: borrower?.email || null,
      federalTaxNumber: borrower?.cpf ? String(borrower.cpf).replace(/\D/g, "") : null,
      address: borrower?.address || null
    }
  };

  // Remove nulls (NFE.io é estrito com campos undefined vs null).
  if (!payload.borrower.email) delete payload.borrower.email;
  if (!payload.borrower.federalTaxNumber) delete payload.borrower.federalTaxNumber;
  if (!payload.borrower.address) delete payload.borrower.address;

  const data = await nfeIoFetch({
    apiToken,
    path: `/companies/${encodeURIComponent(companyId)}/serviceinvoices`,
    method: "POST",
    body: payload
  });

  return {
    nfseId: data?.id || null,
    status: data?.flowStatus || data?.status || "Issued",  // NFE.io retorna flowStatus em async flows
    pdfUrl: data?.pdfUrl || null,
    xmlUrl: data?.xmlUrl || null,
    number: data?.number || null,
    issuedOn: data?.issuedOn || null,
    raw: data
  };
}

// Consulta status de uma NFS-e já submetida.
async function consultarNfse({ apiToken, companyId, nfseId }) {
  if (!nfseId) throw new Error("NFSE_ID_AUSENTE");
  const data = await nfeIoFetch({
    apiToken,
    path: `/companies/${encodeURIComponent(companyId)}/serviceinvoices/${encodeURIComponent(nfseId)}`
  });
  return {
    nfseId: data?.id,
    status: data?.flowStatus || data?.status,
    pdfUrl: data?.pdfUrl || null,
    xmlUrl: data?.xmlUrl || null,
    number: data?.number || null,
    issuedOn: data?.issuedOn || null,
    raw: data
  };
}

// Cancela uma NFS-e emitida.
async function cancelarNfse({ apiToken, companyId, nfseId }) {
  await nfeIoFetch({
    apiToken,
    path: `/companies/${encodeURIComponent(companyId)}/serviceinvoices/${encodeURIComponent(nfseId)}`,
    method: "DELETE"
  });
  return { ok: true };
}

module.exports = {
  testConnection,
  emitirNfse,
  consultarNfse,
  cancelarNfse
};
