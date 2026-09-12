"use strict";

const crypto = require("crypto");

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_WRAPPED_KEY_CHARS = 128;

function decodeBase64(value, expectedBytes, field) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_WRAPPED_KEY_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${field}_INVALIDO`);
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== expectedBytes) throw new Error(`${field}_INVALIDO`);
  return decoded;
}

function readClientEncryption(req) {
  const key = decodeBase64(req.get("x-ai-result-key"), KEY_BYTES, "AI_RESULT_KEY");
  const wrappedKey = String(req.get("x-ai-wrapped-key") || "").trim();
  const wrappedKeyIv = String(req.get("x-ai-wrapped-key-iv") || "").trim();
  decodeBase64(wrappedKey, KEY_BYTES + TAG_BYTES, "AI_WRAPPED_KEY");
  decodeBase64(wrappedKeyIv, IV_BYTES, "AI_WRAPPED_KEY_IV");
  return { key, wrappedKey, wrappedKeyIv };
}

function encryptJson(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("AI_RESULT_KEY_INVALIDO");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  plaintext.fill(0);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
  };
}

function encryptedPayloadResponse(data) {
  if (!data?.payloadCiphertext || !data?.payloadIv || !data?.wrappedKey || !data?.wrappedKeyIv) return null;
  return {
    version: Number(data.encryptionVersion) || 1,
    algorithm: data.encryptionAlgorithm || "AES-256-GCM",
    ciphertext: data.payloadCiphertext,
    iv: data.payloadIv,
    wrappedKey: data.wrappedKey,
    wrappedKeyIv: data.wrappedKeyIv,
  };
}

module.exports = { readClientEncryption, encryptJson, encryptedPayloadResponse };
