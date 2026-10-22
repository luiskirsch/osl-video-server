"use strict";
const express = require("express");
const { counts } = require("../services/admin-notifications");
module.exports = function ({ verifyAdminTherapy, ensureDb, getDb, secret }) {
  const router = express.Router();
  router.get("/therapy/admin/notifications/counts", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (!ensureDb(res) || !await verifyAdminTherapy(req, res)) return;
      res.json({ ok: true, counts: await counts(getDb(), secret), at: Date.now() });
    } catch (error) { next(error); }
  });
  return router;
};
