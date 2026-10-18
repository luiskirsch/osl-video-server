"use strict";
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { sendError } = require("../utils");
const diary = require("../services/diary");

const ENTRY_ID = /^[a-zA-Z0-9-]{1,80}$/;
const localDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
});

module.exports = function createDiaryRouter({ verifyFirebaseToken, ensureDb, getDb, secret,
  today = () => localDate.format(new Date()) }) {
  const router = express.Router();
  const base = "/therapy/paciente/diario";
  // Never copy database/crypto error text into shared logs or responses.
  const handle = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch { sendError(res, 503, "DIARIO_INDISPONIVEL"); }
  };
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  }, rateLimit({
    windowMs: 60000, max: 90, standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: "MUITAS_TENTATIVAS" },
  }), handle(async (req, res, next) => {
    const uid = await verifyFirebaseToken(req, res);
    if (!uid || !ensureDb(res)) return;
    // Ownership comes exclusively from the verified Firebase account.
    // Guardian/student/employee IDs supplied by the client are never used.
    req.diaryUid = uid;
    req.diaryEntries = diary.entriesFor(getDb(), uid);
    next();
  }));

  router.get(base, handle(async (req, res) => {
    let query = req.diaryEntries.orderBy("createdAt", "desc").orderBy("__name__", "desc");
    if (req.query.cursor !== undefined) {
      const raw = req.query.cursor;
      if (typeof raw !== "string" || !raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return sendError(res, 400, "CURSOR_INVALIDO");
      let cursor;
      try { cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
      catch { return sendError(res, 400, "CURSOR_INVALIDO"); }
      if (!cursor || !Number.isSafeInteger(cursor.at) || cursor.at < 0 || typeof cursor.id !== "string" || !ENTRY_ID.test(cursor.id)) return sendError(res, 400, "CURSOR_INVALIDO");
      query = query.startAfter(cursor.at, cursor.id);
    }
    const snapshot = await query.limit(101).get();
    const docs = snapshot.docs.slice(0, 100);
    const date = today();
    const items = docs.map(doc => diary.view(req.diaryUid, doc.id, doc.data(), secret, date));
    const last = docs.at(-1);
    const nextCursor = snapshot.docs.length > 100
      ? Buffer.from(JSON.stringify({ at: last.data().createdAt, id: last.id })).toString("base64url") : null;
    res.json({ ok: true, items, nextCursor });
  }));

  router.put(base + "/:id", handle(async (req, res) => {
    if (!ENTRY_ID.test(req.params.id)) return sendError(res, 400, "ID_INVALIDO");
    let payload;
    const date = today();
    try { payload = diary.normalize(req.body, date); }
    catch (error) { return sendError(res, 400, error.message); }
    const sealed = diary.seal(req.diaryUid, payload, secret);
    const ref = req.diaryEntries.doc(req.params.id);
    let saved;
    try {
      await getDb().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const prior = snapshot.exists ? snapshot.data() : null;
        if ((prior?.version ?? 0) !== req.body.version) throw Object.assign(new Error("REGISTRO_ALTERADO"), { status: 409 });
        if (prior?.kind === "capsule") throw Object.assign(new Error("CAPSULA_SELADA"), { status: 409 });
        const at = Date.now();
        saved = {
          payload: sealed, kind: payload.kind, date: payload.date, unlockDate: payload.unlockDate,
          version: req.body.version + 1, createdAt: prior?.createdAt ?? at, updatedAt: at,
        };
        transaction.set(ref, saved);
      });
    } catch (error) {
      if (error.status === 409) return sendError(res, 409, error.message);
      throw error;
    }
    res.json({ ok: true, item: diary.view(req.diaryUid, req.params.id, saved, secret, date) });
  }));

  router.delete(base + "/:id", handle(async (req, res) => {
    if (!ENTRY_ID.test(req.params.id)) return sendError(res, 400, "ID_INVALIDO");
    const rawVersion = req.query.version;
    const version = typeof rawVersion === "string" && /^[1-9]\d*$/.test(rawVersion) ? Number(rawVersion) : NaN;
    if (!Number.isSafeInteger(version)) return sendError(res, 400, "VERSAO_INVALIDA");
    const ref = req.diaryEntries.doc(req.params.id);
    try {
      await getDb().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return;
        if (snapshot.data().version !== version) throw Object.assign(new Error("REGISTRO_ALTERADO"), { status: 409 });
        transaction.delete(ref);
      });
    } catch (error) {
      if (error.status === 409) return sendError(res, 409, error.message);
      throw error;
    }
    res.json({ ok: true });
  }));
  return router;
};
