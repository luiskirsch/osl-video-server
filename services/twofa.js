// Implementação de TOTP (RFC 6238) usando crypto nativo do Node — sem dependência
// externa. Compatível com Google Authenticator, Authy, 1Password, Bitwarden,
// etc (algoritmo SHA1, 6 dígitos, período 30s — padrão do RFC).

const crypto = require("crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32encode(buf) {
  let bits = 0, value = 0, output = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32decode(str) {
  let bits = 0, value = 0;
  const output = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "")) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// Secret de 20 bytes (160 bits), base32-encoded — padrão TOTP.
function generateSecret() {
  return base32encode(crypto.randomBytes(20));
}

// Calcula TOTP pra um time-step (default = agora). Retorna string de 6 dígitos.
function totp(secret, timeStep) {
  const key = base32decode(secret);
  if (timeStep == null) timeStep = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
    ( hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code.toString().padStart(6, "0");
}

// Verifica código com janela de tolerância (default 1 step antes/depois pra
// acomodar drift de clock — total 90s de janela aceita).
function verifyTotp(secret, code, windowSteps = 1) {
  if (!secret || !code) return false;
  const clean = String(code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const t = Math.floor(Date.now() / 30000);
  for (let i = -windowSteps; i <= windowSteps; i++) {
    if (totp(secret, t + i) === clean) return true;
  }
  return false;
}

// Constrói URI otpauth:// — apps de autenticador escaneiam pra cadastrar.
// label = identificador do usuário (e-mail ou nome).
// issuer = nome da plataforma (aparece no app).
function otpauthUrl({ secret, label, issuer = "Espaço Prelúdio" }) {
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("issuer", issuer);
  params.set("algorithm", "SHA1");
  params.set("digits", "6");
  params.set("period", "30");
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`;
}

module.exports = { generateSecret, totp, verifyTotp, otpauthUrl };
