"use strict";

// PIX "copia e cola" estático (BR Code / EMV-MPM do Banco Central) com valor
// definido. O dinheiro cai direto na chave do profissional; como não há
// intermediário, não existe confirmação automática do pagamento.

function field(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, "0")}${v}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function plain(text, max) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
    .toUpperCase().slice(0, max);
}

// Normaliza a chave conforme o tipo cadastrado no perfil.
function normalizePixKey(key, type) {
  const raw = String(key || "").trim();
  const digits = raw.replace(/\D/g, "");
  switch (String(type || "").toLowerCase()) {
    case "cpf": return digits.length === 11 ? digits : null;
    case "cnpj": return digits.length === 14 ? digits : null;
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
    case "telefone": {
      if (digits.length === 13 && digits.startsWith("55")) return `+${digits}`;
      if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
      return null;
    }
    case "aleatoria": return /^[0-9a-f-]{32,36}$/i.test(raw) ? raw.toLowerCase() : null;
    default: return raw || null;
  }
}

function buildPixPayload({ key, keyType, amountCents, merchantName, merchantCity, txid }) {
  const pixKey = normalizePixKey(key, keyType);
  if (!pixKey) throw new Error("CHAVE_PIX_INVALIDA");
  const cents = Math.round(Number(amountCents));
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("VALOR_INVALIDO");
  const tx = String(txid || "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const body =
    field("00", "01") +
    field("26", field("00", "br.gov.bcb.pix") + field("01", pixKey)) +
    field("52", "0000") +
    field("53", "986") +
    field("54", (cents / 100).toFixed(2)) +
    field("58", "BR") +
    field("59", plain(merchantName, 25) || "PROFISSIONAL") +
    field("60", plain(merchantCity, 15) || "BRASIL") +
    field("62", field("05", tx)) +
    "6304";
  return body + crc16(body);
}

module.exports = { buildPixPayload, normalizePixKey, crc16 };
