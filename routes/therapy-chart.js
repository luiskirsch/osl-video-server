"use strict";

const crypto = require("node:crypto");
const MAX_CIPHERTEXT = 256 * 1024;
const ENTRY_TYPES = new Set(["progress", "soap", "dap", "assessment", "care_plan", "free", "addendum"]);
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);

function encryptedInput(body = {}) {
  const { ciphertext, iv } = body;
  if (typeof ciphertext !== "string" || typeof iv !== "string" ||
      ciphertext.length > MAX_CIPHERTEXT || ciphertext.length < 24 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) ||
      !/^[A-Za-z0-9+/]{16}$/.test(iv)) return null;
  return { ciphertext, iv };
}

// Mounted on the existing therapy router: the same MFA, audit and no-store
// middleware applies. Clinical text never reaches this API in plaintext.
function registerChartRoutes(router, { asyncHandler, ensureDb, getDb, verifyFirebaseToken, sendError, logAudit, timestamp }) {
  const base = "/therapy/pacientes/:patientId/prontuario";
  async function owned(req, res) {
    if (!ensureDb(res)) return null;
    const uid = await verifyFirebaseToken(req, res);
    if (!uid) return null;
    const patientId = req.params.patientId;
    if (!validId(patientId)) { sendError(res, 400, "PACIENTE_OBRIGATORIO"); return null; }
    const db = getDb();
    const ref = db.collection("therapy_patients").doc(patientId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().deleted) { sendError(res, 404, "PACIENTE_NAO_ENCONTRADO"); return null; }
    if (snap.data().therapistUid !== uid) { sendError(res, 403, "ACESSO_NEGADO"); return null; }
    res.set("Cache-Control", "private, no-store");
    return { uid, patientId, db, ref };
  }
  const millis = value => value?.toMillis?.() || (typeof value === "number" ? value : null);

  router.get(base, asyncHandler(async (req, res) => {
    const owner = await owned(req, res); if (!owner) return;
    const snap = await owner.ref.collection("chart").doc("profile").get();
    const data = snap.exists ? snap.data() : {};
    return res.json({ ok: true, exists: snap.exists, version: data.version || 0,
      ciphertext: data.ciphertext || null, iv: data.iv || null, updatedAt: millis(data.updatedAt) });
  }));

  router.put(base, asyncHandler(async (req, res) => {
    const owner = await owned(req, res); if (!owner) return;
    const encrypted = encryptedInput(req.body);
    if (!encrypted) return sendError(res, 400, "CONTEUDO_CIFRADO_INVALIDO");
    const expectedVersion = req.body?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return sendError(res, 400, "VERSAO_OBRIGATORIA");
    const ref = owner.ref.collection("chart").doc("profile");
    const outcome = await owner.db.runTransaction(async tx => {
      const [patient, current] = await Promise.all([tx.get(owner.ref), tx.get(ref)]);
      if (!patient.exists || patient.data().deleted || patient.data().therapistUid !== owner.uid) return { error: "ACESSO_NEGADO", status: 403 };
      const version = current.exists ? current.data().version || 0 : 0;
      if (version !== expectedVersion) return { error: "PRONTUARIO_ATUALIZADO_EM_OUTRA_ABA", status: 409 };
      const next = { ...encrypted, version: version + 1, authorUid: owner.uid, updatedAt: timestamp() };
      if (current.exists) tx.set(owner.ref.collection("chart_versions").doc(String(version)), current.data());
      tx.set(ref, next);
      return { version: next.version };
    });
    if (outcome.error) return sendError(res, outcome.status, outcome.error);
    await logAudit({ type: "chart_profile_updated", patientId: owner.patientId, therapistUid: owner.uid, version: outcome.version });
    return res.json({ ok: true, version: outcome.version });
  }));

  router.get(base + "/registros", asyncHandler(async (req, res) => {
    const owner = await owned(req, res); if (!owner) return;
    const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) return sendError(res, 400, "LIMITE_INVALIDO");
    const limit = requestedLimit;
    let query = owner.ref.collection("chart_entries").orderBy("createdAt", "desc");
    if (req.query.cursor) {
      if (!validId(req.query.cursor)) return sendError(res, 400, "CURSOR_INVALIDO");
      const cursor = await owner.ref.collection("chart_entries").doc(req.query.cursor).get();
      if (!cursor.exists) return sendError(res, 400, "CURSOR_INVALIDO");
      query = query.startAfter(cursor);
    }
    const snap = await query.limit(limit + 1).get();
    const documents = snap.docs.slice(0, limit);
    const entries = documents.map(doc => {
      const data = doc.data();
      return { entryId: doc.id, kind: data.kind, sessionId: data.sessionId || null, parentEntryId: data.parentEntryId || null,
        ciphertext: data.ciphertext, iv: data.iv, authorUid: data.authorUid, createdAt: millis(data.createdAt) };
    });
    return res.json({ ok: true, entries, nextCursor: snap.docs.length > limit ? documents.at(-1).id : null });
  }));

  router.post(base + "/registros", asyncHandler(async (req, res) => {
    const owner = await owned(req, res); if (!owner) return;
    const encrypted = encryptedInput(req.body);
    if (!encrypted) return sendError(res, 400, "CONTEUDO_CIFRADO_INVALIDO");
    const { kind = "progress", sessionId = null, parentEntryId = null, requestId } = req.body;
    if (!ENTRY_TYPES.has(kind)) return sendError(res, 400, "TIPO_REGISTRO_INVALIDO");
    if (!validId(requestId)) return sendError(res, 400, "IDENTIFICADOR_OBRIGATORIO");
    if (sessionId !== null && !validId(sessionId)) return sendError(res, 400, "SESSAO_INVALIDA");
    if (parentEntryId !== null && !validId(parentEntryId)) return sendError(res, 400, "REGISTRO_ORIGEM_INVALIDO");
    if (kind === "addendum" && !parentEntryId) return sendError(res, 400, "REGISTRO_ORIGEM_OBRIGATORIO");
    const entryId = crypto.createHash("sha256").update(owner.uid + ":" + owner.patientId + ":" + requestId).digest("hex");
    const ref = owner.ref.collection("chart_entries").doc(entryId);
    const outcome = await owner.db.runTransaction(async tx => {
      const [patient, current, session, parent] = await Promise.all([
        tx.get(owner.ref), tx.get(ref),
        sessionId ? tx.get(owner.db.collection("therapy_sessions").doc(sessionId)) : null,
        parentEntryId ? tx.get(owner.ref.collection("chart_entries").doc(parentEntryId)) : null
      ]);
      if (!patient.exists || patient.data().deleted || patient.data().therapistUid !== owner.uid) return { status: 403, error: "ACESSO_NEGADO" };
      if (current.exists) {
        if (current.data().ciphertext !== encrypted.ciphertext || current.data().iv !== encrypted.iv ||
            current.data().kind !== kind || (current.data().sessionId || null) !== sessionId ||
            (current.data().parentEntryId || null) !== parentEntryId) return { status: 409, error: "IDENTIFICADOR_JA_UTILIZADO" };
        return { duplicate: true };
      }
      if (sessionId && (!session?.exists || session.data().therapistUid !== owner.uid || session.data().patientId !== owner.patientId)) return { status: 403, error: "SESSAO_NAO_PERTENCE_AO_PACIENTE" };
      if (parentEntryId && !parent?.exists) return { status: 404, error: "REGISTRO_ORIGEM_NAO_ENCONTRADO" };
      tx.create(ref, { ...encrypted, kind, sessionId, parentEntryId, authorUid: owner.uid, createdAt: timestamp() });
      return { duplicate: false };
    });
    if (outcome.error) return sendError(res, outcome.status, outcome.error);
    if (!outcome.duplicate) await logAudit({ type: "chart_entry_created", patientId: owner.patientId, therapistUid: owner.uid, entryId, kind });
    return res.json({ ok: true, entryId, alreadySaved: outcome.duplicate });
  }));
}

module.exports = { registerChartRoutes, encryptedInput };
