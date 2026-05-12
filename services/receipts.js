// services/receipts.js
//
// Recibos eletrônicos de pagamento (NÃO fiscais — não vão pra prefeitura,
// não geram ISS). Validade jurídica como recibo de pagamento (Código Civil
// Art. 320). Algumas operadoras de plano de saúde aceitam pra reembolso.
//
// Coleção Firestore:
//   therapy_receipts/{receiptId}
//
// Numeração sequencial por profissional: começa em 1 e incrementa sem
// gaps. Implementação usa um doc-contador em therapy_receipt_counters/{uid}
// atualizado em transação Firestore — atômico contra emissões simultâneas.
//
// Snapshot do emitente: gravado no recibo no momento da emissão pra que o
// histórico continue legível mesmo se o profissional editar seus dados
// depois (mudou conselho, endereço, etc).
//
// Pra NFSe fiscal (gov.br ou via provider tipo Focus NFe / Nuvem Fiscal),
// criar módulo separado services/nfse.js no futuro.

const VALOR_MIN_CENTS = 1;
const VALOR_MAX_CENTS = 1_000_000_00;
const DESCRIPTION_MAX = 300;
const PATIENT_NAME_MAX = 120;

// Converte centavos pra valor por extenso em português brasileiro.
// Aceita valores entre 1 centavo e R$ 999.999.999,99 (~1 bilhão).
//
// Exemplos:
//   1       → "um centavo"
//   100     → "um real"
//   20000   → "duzentos reais"
//   12345   → "cento e vinte e três reais e quarenta e cinco centavos"
//   100000000 → "um milhão de reais"
function valorPorExtenso(cents) {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0) return "";
  if (cents === 0) return "zero real";

  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;

  const partes = [];
  if (reais > 0) {
    const ext = numeroPorExtenso(reais);
    const sufixoMilhao = reais === 1 ? " milhão" : " milhões";
    const sufixoMilhar = reais === 1 ? " mil" : " mil";
    // numeroPorExtenso já cuida de milhar/milhão, só ajustamos "real"/"reais"
    const moeda = reais === 1 ? "real" : "reais";
    // Caso especial: "um milhão de reais" (com "de") se for milhão exato
    const ehMilhaoExato = reais >= 1_000_000 && reais % 1_000_000 === 0;
    const ehBilhaoExato = reais >= 1_000_000_000 && reais % 1_000_000_000 === 0;
    if (ehMilhaoExato || ehBilhaoExato) {
      partes.push(`${ext} de ${moeda}`);
    } else {
      partes.push(`${ext} ${moeda}`);
    }
  }
  if (centavos > 0) {
    const ext = numeroPorExtenso(centavos);
    const moeda = centavos === 1 ? "centavo" : "centavos";
    if (partes.length > 0) partes.push("e");
    partes.push(`${ext} ${moeda}`);
  }
  return partes.join(" ");
}

// Converte número inteiro de 0 a 999_999_999_999 pra extenso pt-BR.
// Lida com casos especiais: "cento" vs "cem", "e" só nas centenas finais.
function numeroPorExtenso(n) {
  if (n === 0) return "zero";
  if (n < 0) return "menos " + numeroPorExtenso(-n);

  const UNI = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
  const DEZ_19 = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
  const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

  function ate999(num) {
    if (num === 0) return "";
    if (num === 100) return "cem";
    const c = Math.floor(num / 100);
    const resto = num % 100;
    const d = Math.floor(resto / 10);
    const u = resto % 10;
    const out = [];
    if (c > 0) out.push(CENTENAS[c]);
    if (resto > 0 && resto < 10)        out.push(UNI[u]);
    else if (resto >= 10 && resto <= 19) out.push(DEZ_19[resto - 10]);
    else if (resto >= 20) {
      if (u > 0) out.push(`${DEZENAS[d]} e ${UNI[u]}`);
      else       out.push(DEZENAS[d]);
    }
    // Junção: centena E resto (se resto < 100)
    if (c > 0 && resto > 0) return `${out[0]} e ${out.slice(1).join(" ")}`;
    return out.join(" ");
  }

  if (n < 1000) return ate999(n);

  // 1.000 a 999.999
  if (n < 1_000_000) {
    const milhar = Math.floor(n / 1000);
    const resto = n % 1000;
    const milharExt = milhar === 1 ? "mil" : `${ate999(milhar)} mil`;
    if (resto === 0) return milharExt;
    // "e" antes do resto se: resto < 100 OU resto é múltiplo de 100
    const liga = (resto < 100 || resto % 100 === 0) ? " e " : " ";
    return `${milharExt}${liga}${ate999(resto)}`;
  }

  // 1.000.000 a 999.999.999
  if (n < 1_000_000_000) {
    const milhao = Math.floor(n / 1_000_000);
    const resto = n % 1_000_000;
    const milhaoExt = milhao === 1 ? "um milhão" : `${ate999(milhao)} milhões`;
    if (resto === 0) return milhaoExt;
    return `${milhaoExt} ${numeroPorExtenso(resto)}`;
  }

  // Bilhões — pouco relevante mas implementado pra simetria
  const bilhao = Math.floor(n / 1_000_000_000);
  const resto = n % 1_000_000_000;
  const bilhaoExt = bilhao === 1 ? "um bilhão" : `${ate999(bilhao)} bilhões`;
  if (resto === 0) return bilhaoExt;
  return `${bilhaoExt} ${numeroPorExtenso(resto)}`;
}

// Labels human-readable dos métodos de pagamento (mesma matriz do
// services/financial.js mas reproduzida aqui pra evitar import cruzado).
const PAYMENT_METHOD_LABELS = {
  "pix":             "Pix",
  "dinheiro":        "Dinheiro",
  "cartao-credito":  "Cartão de crédito",
  "cartao-debito":   "Cartão de débito",
  "transferencia":   "Transferência bancária",
  "boleto":          "Boleto",
  "outro":           "Outro"
};

module.exports = {
  VALOR_MIN_CENTS,
  VALOR_MAX_CENTS,
  DESCRIPTION_MAX,
  PATIENT_NAME_MAX,
  valorPorExtenso,
  numeroPorExtenso,
  PAYMENT_METHOD_LABELS
};
