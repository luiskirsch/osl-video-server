// Rotas admin de segurança: gerenciamento de denúncias e banimentos.
// Todas as rotas requerem x-admin-secret (requireAdmin).
// Coleções Firestore: security_reports, security_bans.

const express = require("express");
const { requireAdmin } = require("../services/auth");
const { asyncHandler, sendError } = require("../utils");
const {
  banUser, unbanUser,
  listReports, reviewReport, listBans,
  VALID_REASONS,
} = require("../services/abuseGuard");

const router = express.Router();

// GET /admin/security/reports?status=pending&limit=50
router.get("/admin/security/reports", requireAdmin, asyncHandler(async (req, res) => {
  const status = req.query.status || null;
  const limit  = Math.min(Number(req.query.limit || 50), 200);
  const reports = await listReports({ status, limit });
  return res.json({ ok: true, reports, count: reports.length });
}));

// PUT /admin/security/reports/:id — reviewed | dismissed
router.put("/admin/security/reports/:id", requireAdmin, asyncHandler(async (req, res) => {
  const reportId = String(req.params.id || "").trim();
  const status   = String(req.body?.status || "").trim();
  if (!reportId || !status) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  try {
    await reviewReport(reportId, { status, reviewedBy: "admin" });
    return res.json({ ok: true });
  } catch (err) {
    if (err.message === "STATUS_INVALIDO") return sendError(res, 400, "STATUS_INVALIDO");
    throw err;
  }
}));

// GET /admin/security/bans?all=true  (all=true inclui bans inativos)
router.get("/admin/security/bans", requireAdmin, asyncHandler(async (req, res) => {
  const activeOnly = req.query.all !== "true";
  const bans = await listBans({ activeOnly });
  return res.json({ ok: true, bans, count: bans.length });
}));

// POST /admin/security/banir — banir manualmente
router.post("/admin/security/banir", requireAdmin, asyncHandler(async (req, res) => {
  const uid    = String(req.body?.uid    || "").trim();
  const reason = String(req.body?.reason || "").trim();
  const note   = String(req.body?.note   || "").trim();
  if (!uid || !reason) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  await banUser({ uid, reason, bannedBy: "admin", note });
  return res.json({ ok: true });
}));

// DELETE /admin/security/banir/:uid — desbanir
router.delete("/admin/security/banir/:uid", requireAdmin, asyncHandler(async (req, res) => {
  const uid = String(req.params.uid || "").trim();
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  await unbanUser(uid, "admin");
  return res.json({ ok: true });
}));

// GET /admin/security/motivos — lista motivos válidos (para o frontend admin)
router.get("/admin/security/motivos", requireAdmin, (req, res) => {
  return res.json({ ok: true, motivos: VALID_REASONS });
});

module.exports = router;
