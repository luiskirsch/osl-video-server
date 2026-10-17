"use strict";
// E-mails de conta (redefinir senha, confirmar e-mail) enviados pelo próprio
// Espaço Prelúdio em vez do Firebase: texto em português, remetente do
// domínio espacopreludio.com.br e link para conta-acao.html no site. O
// Firebase só gera o código de uso único (Admin SDK); o envio é via Resend.
// O plano gratuito do Firebase não deixa personalizar os e-mails dele.
const crypto = require("node:crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { asyncHandler, sendError } = require("../utils");
const { logInfo, logWarn } = require("../logger");

// Destinos de retorno por fluxo. Profissional e paciente voltam ao passo da
// chave-semente, que reconecta as anotações cifradas à nova senha.
const RESET_RETURN = {
  profissional: "recuperar.html?passo=2", paciente: "paciente-recuperar.html?passo=2",
  "app-paciente": "app/recuperar.html?passo=2", admin: "admin-login.html", aluno: "aluno-login.html",
  instituicao: "instituicao-login.html", rt: "rt-login.html"
};
const VERIFY_RETURN = {
  profissional: "login.html", paciente: "paciente-login.html", "app-paciente": "app/login.html",
  admin: "admin-login.html", aluno: "aluno-login.html", instituicao: "instituicao-login.html", rt: "rt-login.html"
};

function normalizeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}
const emailKey = email => crypto.createHash("sha256").update(email).digest("hex");

function siteBaseFor({ frontendBase, isStaging }) {
  const base = String(frontendBase || "https://espacopreludio.com.br").replace(/\/+$/, "");
  return isStaging && !/\/staging$/.test(base) ? base + "/staging" : base;
}

// Troca o link do handler padrão do Firebase pelo nosso, mantendo o código.
function toSiteLink(firebaseLink, { site, continueUrl, lang }) {
  const generated = new URL(firebaseLink);
  const mode = generated.searchParams.get("mode");
  const oobCode = generated.searchParams.get("oobCode");
  if (!mode || !oobCode) throw new Error("LINK_DE_ACAO_INVALIDO");
  const ours = new URL(site + "/conta-acao.html");
  ours.searchParams.set("mode", mode);
  ours.searchParams.set("oobCode", oobCode);
  if (continueUrl) ours.searchParams.set("continueUrl", continueUrl);
  if (lang && lang !== "pt-BR") ours.searchParams.set("lang", lang);
  return ours.href;
}

function createAccountRouter(deps = {}) {
  const config = deps.config || require("../config");
  const auth = deps.auth || (() => { require("../services/firestore"); return require("firebase-admin").auth(); });
  const email = deps.email || require("../services/email");
  const authenticate = deps.authenticate || require("../services/auth").verifyFirebaseToken;
  const localeFor = deps.localeFor || require("../services/user-locale").localeForEmail;
  // Conta inexistente responde no mesmo tempo aproximado de um envio real:
  // o tempo da resposta não pode revelar quem tem cadastro.
  const delay = deps.delay || (() => new Promise(resolve => setTimeout(resolve, 400 + crypto.randomInt(400))));
  const site = siteBaseFor({ frontendBase: config.THERAPY_FRONTEND_BASE, isStaging: config.IS_STAGING });
  const limited = { ok: false, error: "MUITAS_TENTATIVAS" };

  const router = express.Router();
  const ipLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: limited });
  const resetEmailLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => "reset:" + emailKey(req.accountEmail), message: limited });
  const verifyUidLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => "verify:" + req.firebaseUid, message: limited });

  async function deliver({ to, template, link }) {
    const message = template({ email: to, actionUrl: link });
    return email.sendEmail({ to, ...message, from: config.ACCOUNT_EMAIL_FROM, replyTo: "contato@espacopreludio.com.br" });
  }

  // Público. Responde igual exista ou não a conta: não revela quem é cliente.
  router.post("/conta/redefinir-senha", ipLimit, (req, res, next) => {
    req.accountEmail = normalizeEmail(req.body?.email);
    if (!req.accountEmail) return sendError(res, 400, "EMAIL_INVALIDO");
    const flow = String(req.body?.retorno || "");
    if (flow && !Object.hasOwn(RESET_RETURN, flow)) return sendError(res, 400, "RETORNO_INVALIDO");
    req.accountReturn = flow ? `${site}/${RESET_RETURN[flow]}` : "";
    return next();
  }, resetEmailLimit, asyncHandler(async (req, res) => {
    const to = req.accountEmail, continueUrl = req.accountReturn;
    // Com a proteção contra enumeração de e-mails ligada, o Firebase não gera
    // link para conta inexistente e o Admin SDK falha com um erro genérico.
    // Por isso a existência é conferida antes.
    let account = null;
    try { account = await auth().getUserByEmail(to); }
    catch (error) { if (error?.code !== "auth/user-not-found") throw error; }
    if (!account || account.disabled) {
      logInfo("account_reset_no_account", { emailHash: emailKey(to).slice(0, 12) });
      await delay();
      return res.json({ ok: true });
    }
    const link = await auth().generatePasswordResetLink(to, continueUrl ? { url: continueUrl } : undefined);
    const sent = await deliver({ to, template: email.templateAccountPasswordReset,
      link: toSiteLink(link, { site, continueUrl, lang: await localeFor(to) }) });
    if (!sent?.ok) return sendError(res, 503, "EMAIL_INDISPONIVEL");
    return res.json({ ok: true });
  }));

  // Autenticado: reenvia a confirmação do e-mail da própria conta.
  router.post("/conta/verificar-email", ipLimit, asyncHandler(async (req, res, next) => {
    const uid = await authenticate(req, res, { checkRevoked: true });
    if (!uid) return;
    return next();
  }), verifyUidLimit, asyncHandler(async (req, res) => {
    const flow = String(req.body?.retorno || "");
    if (flow && !Object.hasOwn(VERIFY_RETURN, flow)) return sendError(res, 400, "RETORNO_INVALIDO");
    const decoded = req.verifiedFirebaseToken || {};
    const to = normalizeEmail(decoded.email);
    if (!to) return sendError(res, 400, "CONTA_SEM_EMAIL");
    if (decoded.email_verified === true) return res.json({ ok: true, alreadyVerified: true });
    const continueUrl = flow ? `${site}/${VERIFY_RETURN[flow]}` : "";
    const link = await auth().generateEmailVerificationLink(to, continueUrl ? { url: continueUrl } : undefined);
    const sent = await deliver({ to, template: email.templateAccountVerifyEmail,
      link: toSiteLink(link, { site, continueUrl, lang: await localeFor(to) }) });
    if (!sent?.ok) {
      logWarn("account_verify_email_not_sent", { uid: req.firebaseUid });
      return sendError(res, 503, "EMAIL_INDISPONIVEL");
    }
    return res.json({ ok: true });
  }));

  return router;
}

module.exports = createAccountRouter;
module.exports.toSiteLink = toSiteLink;
module.exports.siteBaseFor = siteBaseFor;
module.exports.RESET_RETURN = RESET_RETURN;
module.exports.VERIFY_RETURN = VERIFY_RETURN;
