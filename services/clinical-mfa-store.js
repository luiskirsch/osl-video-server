"use strict";
const crypto = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { getDb } = require("./firestore");
const { ACCESS_TOKEN_SECRET } = require("../config");
const { generateSecret, totp, otpauthUrl } = require("./twofa");
const { signPayload } = require("./auth");

const COLLECTION = "therapy_security_accounts";
const SESSION_MS = 2 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
function error(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function currentStep(secret, code, now) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (let delta = -1; delta <= 1; delta++) {
    const candidate = step + delta;
    if (candidate >= 0 && crypto.timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}

function createMfaStore({ database = getDb, signingSecret = ACCESS_TOKEN_SECRET, now = Date.now } = {}) {
  function key(uid, purpose = "secret") {
    if (typeof signingSecret !== "string" || signingSecret.length < 32) throw error("MFA_SECRET_NAO_CONFIGURADO", 503);
    return Buffer.from(crypto.hkdfSync("sha256", signingSecret, "clinical-mfa-v2", purpose + ":" + uid, 32));
  }
  function seal(uid, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(uid), iv);
    cipher.setAAD(Buffer.from(uid));
    return { v: 1, iv: iv.toString("base64"), data: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64") };
  }
  function open(uid, envelope) {
    if (envelope?.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.data !== "string") throw error("MFA_SECRET_INVALIDO", 503);
    const iv = Buffer.from(envelope.iv, "base64"), bytes = Buffer.from(envelope.data, "base64");
    if (iv.length !== 12 || bytes.length <= 16 || bytes.length > 256) throw error("MFA_SECRET_INVALIDO", 503);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(uid), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(uid)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8");
  }
  function recoveryHash(uid, version, code) {
    const normalized = String(code || "").replace(/[-\s]/g, "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
    return crypto.createHmac("sha256", key(uid, "recovery")).update("recovery:" + version + ":" + normalized).digest("hex");
  }
  function recoverySet(uid, version) {
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(16).toString("hex").match(/.{1,8}/g).join("-"));
    return { codes, hashes: codes.map(code => recoveryHash(uid, version, code)) };
  }
  function db() { const value = database(); if (!value) throw error("FIREBASE_ADMIN_NAO_CONFIGURADO", 503); return value; }
  function refs(uid) {
    return { security: db().collection(COLLECTION).doc(uid), professional: db().collection("therapists").doc(uid) };
  }
  function merged(security, professional) {
    if (!security.exists && !professional.exists) return null;
    return { ...(professional.exists ? professional.data() : {}), ...(security.exists ? security.data() : {}), registeredProfessional: professional.exists };
  }
  async function load(uid) {
    const ref = refs(uid);
    const [security, professional] = await Promise.all([ref.security.get(), ref.professional.get()]);
    return merged(security, professional);
  }
  async function transaction(uid, operation) {
    const ref = refs(uid);
    return db().runTransaction(async tx => {
      const security = await tx.get(ref.security), professional = await tx.get(ref.professional);
      const state = merged(security, professional) || {};
      const result = await operation(state, tx, ref);
      return result;
    });
  }
  function audit(tx, uid, type) {
    tx.create(db().collection("therapy_audit").doc(), { type, therapistUid: uid,
      source: "clinical_mfa_v2", createdAt: FieldValue.serverTimestamp() });
  }
  function session(uid, state, authTime) {
    if (!Number.isSafeInteger(authTime) || authTime <= 0) throw error("AUTENTICACAO_RECENTE_INVALIDA", 401);
    return signPayload({ token_type: "twofa_session", uid, version: String(state.twoFactorVersion || "legacy"),
      auth_time: authTime, iat: now(), exp: now() + SESSION_MS }, signingSecret);
  }
  async function setup(uid, label) {
    const secret = generateSecret();
    await transaction(uid, async (state, tx, ref) => {
      if (state.twoFactorEnabled) throw error("JA_ATIVADO", 409);
      tx.set(ref.security, { twoFactorRequired: true, twoFactorPendingSealed: seal(uid, secret),
        twoFactorPendingExpiresAt: now() + PENDING_MS, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      audit(tx, uid, "twofa_setup");
    });
    return { secret, otpauthUrl: otpauthUrl({ secret, label }), expiresInSeconds: PENDING_MS / 1000 };
  }
  async function enable(uid, code, authTime) {
    return transaction(uid, async (state, tx, ref) => {
      if (state.twoFactorEnabled) throw error("JA_ATIVADO", 409);
      if (!state.twoFactorPendingSealed || !(state.twoFactorPendingExpiresAt > now())) throw error("SETUP_EXPIRADO");
      const secret = open(uid, state.twoFactorPendingSealed);
      const step = currentStep(secret, code, now());
      if (step === null) throw error("CODIGO_INCORRETO", 401);
      const version = crypto.randomBytes(16).toString("hex");
      const recovery = recoverySet(uid, version);
      const next = { twoFactorRequired: true, twoFactorEnabled: true, twoFactorVersion: version,
        twoFactorSecretSealed: seal(uid, secret), twoFactorPendingSealed: FieldValue.delete(),
        twoFactorPendingExpiresAt: FieldValue.delete(), twoFactorLastStep: step, twoFactorRecoveryHashes: recovery.hashes,
        twoFactorEnabledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
      const sessionToken = session(uid, next, authTime);
      tx.set(ref.security, next, { merge: true }); audit(tx, uid, "twofa_enabled");
      return { sessionToken, recoveryCodes: recovery.codes };
    });
  }
  async function verify(uid, code, authTime, { renewRecovery = false } = {}) {
    return transaction(uid, async (state, tx, ref) => {
      if (!state.twoFactorEnabled) throw error("TWOFA_ENROLLMENT_REQUIRED", 401);
      const secret = state.twoFactorSecretSealed ? open(uid, state.twoFactorSecretSealed) : state.twoFactorSecret;
      if (!secret) throw error("MFA_SECRET_INVALIDO", 503);
      const step = currentStep(secret, code, now());
      if (step === null) throw error("CODIGO_INCORRETO", 401);
      if (step <= Number(state.twoFactorLastStep ?? -1)) throw error("CODIGO_REUTILIZADO", 401);
      const next = { twoFactorRequired: true, twoFactorEnabled: true, twoFactorVersion: String(state.twoFactorVersion || "legacy"),
        twoFactorSecretSealed: state.twoFactorSecretSealed || seal(uid, secret), twoFactorLastStep: step,
        updatedAt: FieldValue.serverTimestamp() };
      const sessionToken = session(uid, next, authTime);
      const result = { sessionToken };
      if (renewRecovery) {
        const recovery = recoverySet(uid, next.twoFactorVersion);
        next.twoFactorRecoveryHashes = recovery.hashes;
        result.recoveryCodes = recovery.codes;
      }
      tx.set(ref.security, next, { merge: true }); audit(tx, uid, renewRecovery ? "twofa_recovery_codes_renewed" : "twofa_verified");
      return result;
    });
  }
  async function recover(uid, code) {
    return transaction(uid, async (state, tx, ref) => {
      const hash = recoveryHash(uid, state.twoFactorVersion, code);
      if (!state.twoFactorEnabled || !hash || !Array.isArray(state.twoFactorRecoveryHashes) ||
          !state.twoFactorRecoveryHashes.some(value => typeof value === "string" && value.length === hash.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(hash)))) {
        throw error("CODIGO_RECUPERACAO_INVALIDO", 401);
      }
      // Recovery never removes the requirement. It revokes existing sessions
      // and requires enrollment of a new authenticator before any clinical access.
      tx.set(ref.security, { twoFactorRequired: true, twoFactorEnabled: false,
        twoFactorVersion: crypto.randomBytes(16).toString("hex"), twoFactorSecretSealed: FieldValue.delete(),
        twoFactorPendingSealed: FieldValue.delete(), twoFactorPendingExpiresAt: FieldValue.delete(),
        twoFactorLastStep: FieldValue.delete(), twoFactorRecoveryHashes: [], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      // Clear legacy state too, otherwise its old secret could re-enable the gate.
      if (state.registeredProfessional) tx.set(ref.professional, { twoFactorEnabled: false,
        twoFactorSecret: FieldValue.delete(), twoFactorPendingSecret: FieldValue.delete(), twoFactorVersion: FieldValue.delete() }, { merge: true });
      audit(tx, uid, "twofa_recovered_reenrollment_required");
      return { status: "reenrollment_required" };
    });
  }
  return { load, setup, enable, verify, recover, session };
}

const store = createMfaStore();
module.exports = { createMfaStore, loadMfaProfile: store.load, store, currentStep, SESSION_MS };
