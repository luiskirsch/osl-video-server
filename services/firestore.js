const admin = require("firebase-admin");
const { logInfo, logWarn } = require("../logger");
const { sendError, normalizeUid, normalizeEmail, buildDiscordAvatarUrl } = require("../utils");

// --- Inicialização do Firebase Admin ---

function parseServiceAccountFromEnv() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!rawJson) throw new Error("FIREBASE_ADMIN_NAO_CONFIGURADO");
  const parsed = JSON.parse(rawJson);
  if (parsed.private_key) {
    parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  }
  return parsed;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.firestore();
  const serviceAccount = parseServiceAccountFromEnv();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   serviceAccount.project_id  || serviceAccount.projectId,
      clientEmail: serviceAccount.client_email || serviceAccount.clientEmail,
      privateKey:  serviceAccount.private_key
    })
  });
  return admin.firestore();
}

let db = null;

try {
  db = initFirebaseAdmin();
  logInfo("firebase_admin_initialized");
} catch (error) {
  logWarn("firebase_admin_not_configured", { detail: error.message });
}

function getDb() { return db; }

function ensureDb(res) {
  if (!db) { sendError(res, 500, "FIREBASE_ADMIN_NAO_CONFIGURADO"); return false; }
  return true;
}

// --- Operações de usuário / Discord ---

async function saveDiscordLinkToUser({ uid, discordUser, discordAccessToken }) {
  const userRef = db.collection("users").doc(uid);
  await userRef.set(
    {
      discordLinked: true,
      discordUserId: String(discordUser.id || ""),
      discordUsername: String(discordUser.username || ""),
      discordGlobalName: String(discordUser.global_name || ""),
      discordAvatar: buildDiscordAvatarUrl(discordUser),
      discordAccessToken: String(discordAccessToken || ""),
      discordLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  const snap = await userRef.get();
  return snap.exists ? snap.data() : null;
}

async function getUserProfileByUid(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function getAffiliateProfileByUid(uid) {
  const snap = await db.collection("affiliates").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

// --- Operações de licença ---

async function saveLicenseRecord(record) {
  const ref = db.collection("licenses").doc(record.licenseCode);
  await ref.set(
    {
      licenseCode: record.licenseCode,
      licenseToken: record.licenseToken,
      paymentId: record.paymentId,
      externalReference: record.externalReference,
      email: record.email,
      nome: record.nome || "",
      product: record.product,
      amount: record.amount,
      currency: record.currency,
      status: "active",
      exp: record.exp,
      boundToUid: "",
      boundToEmail: "",
      firstActivatedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function claimOrValidateLicenseOwnership({ licenseCode, uid, email }) {
  const normalizedUid   = normalizeUid(uid);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid) return { ok: false, status: 400, error: "UID_OBRIGATORIO" };

  const ref = db.collection("licenses").doc(licenseCode);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: "LICENCA_NAO_ENCONTRADA" };

    const license = snap.data();
    const s = license.status;

    if (s && s !== "active") return { ok: false, status: 401, error: "LICENCA_INATIVA" };
    if (license.exp && Date.now() > Number(license.exp)) {
      return { ok: false, status: 401, error: "LICENCA_EXPIRADA" };
    }

    const boundToUid   = normalizeUid(license.boundToUid);
    const boundToEmail = normalizeEmail(license.boundToEmail);

    if (!boundToUid) {
      tx.set(ref, {
        boundToUid: normalizedUid,
        boundToEmail: normalizedEmail,
        firstActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { ok: true, claimedNow: true, license: { ...license, boundToUid: normalizedUid, boundToEmail: normalizedEmail } };
    }

    if (boundToUid === normalizedUid) {
      if (!boundToEmail && normalizedEmail) {
        tx.set(ref, { boundToEmail: normalizedEmail, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      return { ok: true, claimedNow: false, license: { ...license, boundToUid, boundToEmail: boundToEmail || normalizedEmail } };
    }

    return { ok: false, status: 403, error: "LICENCA_JA_VINCULADA_A_OUTRA_CONTA" };
  });
}

module.exports = {
  getDb, ensureDb,
  saveDiscordLinkToUser, getUserProfileByUid, getAffiliateProfileByUid,
  saveLicenseRecord, claimOrValidateLicenseOwnership
};
