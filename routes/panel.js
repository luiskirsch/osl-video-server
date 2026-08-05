// Autenticação do painel administrativo web.
// PANEL_PASSWORD (env var) é a senha da tela de login.
// Se não configurado, cai para ADMIN_SECRET como fallback.
// Retorna um panel session token assinado (TTL 8h) — nenhum secret
// toca o browser além do token derivado.

const express = require("express");
const { requireAdmin, generatePanelToken, timingSafeStringEqual } = require("../services/auth");
const { panelLoginLimiter } = require("../services/rateLimit");
const { logWarn, logInfo } = require("../logger");

const router = express.Router();

function panelPassword() {
  return process.env.PANEL_PASSWORD || process.env.ADMIN_SECRET || "";
}

// POST /admin/panel/auth — valida senha, retorna token de sessão
router.post("/admin/panel/auth", panelLoginLimiter, (req, res) => {
  const password = String(req.body?.password || "");
  const expected = panelPassword();

  if (!expected) {
    logWarn("panel_login_no_password_configured", {});
    return res.status(503).json({ ok: false, error: "PAINEL_NAO_CONFIGURADO" });
  }

  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;

  if (!password || !timingSafeStringEqual(password, expected)) {
    logWarn("panel_login_failed", { ip });
    return res.status(401).json({ ok: false, error: "SENHA_INCORRETA" });
  }

  let token;
  try { token = generatePanelToken(); }
  catch (err) {
    return res.status(503).json({ ok: false, error: "ADMIN_SECRET_NAO_CONFIGURADO" });
  }

  logInfo("panel_login_success", { ip });
  return res.json({ ok: true, token });
});

// GET /admin/panel/verify — confirma que o token ainda é válido (usado no page load)
router.get("/admin/panel/verify", requireAdmin, (_req, res) => {
  return res.json({ ok: true });
});

module.exports = router;
