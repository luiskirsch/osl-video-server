// Autenticação do painel administrativo web.
// PANEL_PASSWORD (env var) é a senha da tela de login.
// PANEL_TOTP_SECRET (env var, base32) habilita 2FA via TOTP.
// Se nenhum dos dois estiver configurado, o auth falha (fail-closed).
// Retorna um panel session token assinado (TTL 8h) — nenhum secret
// toca o browser além do token derivado.

const express = require("express");
const { requireAdmin, generatePanelToken, timingSafeStringEqual } = require("../services/auth");
const { panelLoginLimiter } = require("../services/rateLimit");
const { totpVerify } = require("../services/totp");
const { PANEL_TOTP_SECRET, IS_PRODUCTION } = require("../config");
const { logWarn, logInfo } = require("../logger");

const router = express.Router();

function panelPassword() {
  return process.env.PANEL_PASSWORD || process.env.ADMIN_SECRET || "";
}

// POST /admin/panel/auth — valida senha + TOTP (se configurado), retorna token de sessão
router.post("/admin/panel/auth", panelLoginLimiter, (req, res) => {
  const password = String(req.body?.password || "");
  const expected = panelPassword();
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;

  if (!expected) {
    logWarn("panel_login_no_password_configured", {});
    return res.status(503).json({ ok: false, error: "PAINEL_NAO_CONFIGURADO" });
  }

  // Usa o mesmo código de erro pra senha e TOTP incorretos — não revelamos
  // qual dos dois falhou (não deixa atacante saber que a senha estava certa).
  const senhaOk = password && timingSafeStringEqual(password, expected);
  if (!senhaOk) {
    logWarn("panel_login_failed", { ip, reason: "senha" });
    return res.status(401).json({ ok: false, error: "AUTENTICACAO_FALHOU" });
  }

  // 2FA: obrigatório em produção — sem PANEL_TOTP_SECRET configurado, bloqueia login.
  if (IS_PRODUCTION && !PANEL_TOTP_SECRET) {
    logWarn("panel_login_blocked_no_totp", { ip });
    return res.status(503).json({ ok: false, error: "2FA_OBRIGATORIO_EM_PRODUCAO" });
  }
  if (PANEL_TOTP_SECRET) {
    const code = String(req.body?.totp || "").replace(/\s/g, "");
    if (!totpVerify(PANEL_TOTP_SECRET, code)) {
      logWarn("panel_login_failed", { ip, reason: "totp" });
      return res.status(401).json({ ok: false, error: "AUTENTICACAO_FALHOU" });
    }
  }

  let token;
  try { token = generatePanelToken(); }
  catch {
    return res.status(503).json({ ok: false, error: "ADMIN_SECRET_NAO_CONFIGURADO" });
  }

  logInfo("panel_login_success", { ip, totp: !!PANEL_TOTP_SECRET });
  return res.json({ ok: true, token });
});

// GET /admin/panel/verify — confirma que o token ainda é válido (usado no page load)
router.get("/admin/panel/verify", requireAdmin, (_req, res) => {
  return res.json({ ok: true });
});

// GET /admin/panel/status — informa se 2FA está habilitado (sem revelar o secret)
router.get("/admin/panel/status", (req, res) => {
  return res.json({ totpEnabled: !!PANEL_TOTP_SECRET });
});

module.exports = router;
