// RFC 6238 TOTP — implementação pura Node.js (sem dependência externa).
// Compatível com Google Authenticator, Authy e qualquer app TOTP padrão.

const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const s = input.replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Char base32 inválido: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = mac[19] & 0xf;
  const code = ((mac[offset]     & 0x7f) << 24 |
                (mac[offset + 1] & 0xff) << 16 |
                (mac[offset + 2] & 0xff) << 8  |
                (mac[offset + 3] & 0xff)) % 1_000_000;
  return String(code).padStart(6, "0");
}

// Verifica um código TOTP com janela de ±1 período (±30 s de drift de relógio).
function totpVerify(secret, token) {
  if (!secret) return false;
  const clean = String(token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  let key;
  try { key = base32Decode(secret); } catch { return false; }
  const t = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    if (hotp(key, t + d) === clean) return true;
  }
  return false;
}

module.exports = { totpVerify };
