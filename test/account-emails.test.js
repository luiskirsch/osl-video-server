"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const createAccountRouter = require("../routes/account");
const { toSiteLink, siteBaseFor } = createAccountRouter;

const FIREBASE_LINK = "https://osextolugar-game.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=CODE_123-abc&apiKey=k&lang=en";

function harness({ users = {}, verified = false, sendOk = true, staging = false } = {}) {
  const sent = [];
  const generated = [];
  const router = createAccountRouter({
    config: { THERAPY_FRONTEND_BASE: "https://espacopreludio.com.br", IS_STAGING: staging, ACCOUNT_EMAIL_FROM: "EP <conta@espacopreludio.com.br>" },
    auth: () => ({
      async generatePasswordResetLink(email, settings) {
        if (!users[email]) throw Object.assign(new Error("nope"), { code: "auth/user-not-found" });
        generated.push({ email, settings });
        return FIREBASE_LINK;
      },
      async generateEmailVerificationLink(email, settings) {
        generated.push({ email, settings });
        return FIREBASE_LINK.replace("resetPassword", "verifyEmail");
      }
    }),
    email: {
      templateAccountPasswordReset: ({ email, actionUrl }) => ({ subject: "reset", html: actionUrl, text: email }),
      templateAccountVerifyEmail: ({ email, actionUrl }) => ({ subject: "verify", html: actionUrl, text: email }),
      async sendEmail(message) { sent.push(message); return { ok: sendOk }; }
    },
    authenticate: async (req, res) => {
      if (req.headers.authorization !== "Bearer ok") { res.status(401).json({ ok: false }); return null; }
      req.verifiedFirebaseToken = { uid: "u1", email: "pro@exemplo.com", email_verified: verified };
      req.firebaseUid = "u1";
      return "u1";
    },
    localeFor: async () => "pt-BR"
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => res.status(500).json({ ok: false, error: err.message }));
  return { app, sent, generated };
}

async function post(app, path, body, headers = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("link do e-mail aponta para o site e preserva o código de uso único", () => {
  const link = new URL(toSiteLink(FIREBASE_LINK, { site: "https://espacopreludio.com.br",
    continueUrl: "https://espacopreludio.com.br/recuperar.html?passo=2", lang: "pt-BR" }));
  assert.equal(link.origin + link.pathname, "https://espacopreludio.com.br/conta-acao.html");
  assert.equal(link.searchParams.get("mode"), "resetPassword");
  assert.equal(link.searchParams.get("oobCode"), "CODE_123-abc");
  assert.equal(link.searchParams.get("continueUrl"), "https://espacopreludio.com.br/recuperar.html?passo=2");
  assert.equal(link.searchParams.has("apiKey"), false);
  assert.equal(link.searchParams.has("lang"), false);
  assert.throws(() => toSiteLink("https://x.firebaseapp.com/__/auth/action?mode=resetPassword", { site: "https://espacopreludio.com.br" }));
  assert.equal(siteBaseFor({ frontendBase: "https://espacopreludio.com.br/", isStaging: true }), "https://espacopreludio.com.br/staging");
  assert.equal(siteBaseFor({ frontendBase: "https://espacopreludio.com.br/staging", isStaging: true }), "https://espacopreludio.com.br/staging");
});

test("redefinição envia nosso e-mail com retorno ao passo da chave-semente", async () => {
  const { app, sent, generated } = harness({ users: { "pro@exemplo.com": true } });
  const response = await post(app, "/conta/redefinir-senha", { email: " Pro@Exemplo.com ", retorno: "profissional" });
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  assert.equal(generated[0].settings.url, "https://espacopreludio.com.br/recuperar.html?passo=2");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "pro@exemplo.com");
  assert.equal(sent[0].from, "EP <conta@espacopreludio.com.br>");
  assert.match(sent[0].html, /^https:\/\/espacopreludio\.com\.br\/conta-acao\.html\?mode=resetPassword&oobCode=CODE_123-abc/);
});

test("conta inexistente recebe a mesma resposta e nenhum e-mail (sem revelar cadastro)", async () => {
  const { app, sent } = harness();
  const response = await post(app, "/conta/redefinir-senha", { email: "ninguem@exemplo.com", retorno: "paciente" });
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  assert.equal(sent.length, 0);
});

test("entradas inválidas e destinos fora da lista são recusados", async () => {
  const { app } = harness({ users: { "a@b.com": true } });
  assert.equal((await post(app, "/conta/redefinir-senha", { email: "sem-arroba" })).status, 400);
  assert.equal((await post(app, "/conta/redefinir-senha", { email: "a@b.com", retorno: "https://evil.example" })).body.error, "RETORNO_INVALIDO");
  assert.equal((await post(app, "/conta/redefinir-senha", { email: "a@b.com", retorno: "__proto__" })).body.error, "RETORNO_INVALIDO");
});

test("limite por e-mail barra a quarta tentativa na hora", async () => {
  const { app, sent } = harness({ users: { "a@b.com": true } });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(app, "/conta/redefinir-senha", { email: "a@b.com" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(sent.length, 3);
});

test("falha no envio responde 503 para o site usar o envio de reserva", async () => {
  const { app } = harness({ users: { "a@b.com": true }, sendOk: false });
  assert.equal((await post(app, "/conta/redefinir-senha", { email: "a@b.com" })).status, 503);
});

test("confirmação de e-mail exige login, não reenvia a quem já confirmou e usa o site de staging", async () => {
  assert.equal((await post(harness().app, "/conta/verificar-email", {})).status, 401);
  const done = harness({ verified: true });
  assert.deepEqual((await post(done.app, "/conta/verificar-email", { retorno: "paciente" }, { Authorization: "Bearer ok" })).body,
    { ok: true, alreadyVerified: true });
  assert.equal(done.sent.length, 0);
  const staging = harness({ staging: true });
  const response = await post(staging.app, "/conta/verificar-email", { retorno: "paciente" }, { Authorization: "Bearer ok" });
  assert.deepEqual(response.body, { ok: true });
  assert.equal(staging.generated[0].settings.url, "https://espacopreludio.com.br/staging/paciente-login.html");
  assert.match(staging.sent[0].html, /^https:\/\/espacopreludio\.com\.br\/staging\/conta-acao\.html\?mode=verifyEmail/);
});
