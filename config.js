const PORT = Number(process.env.PORT || 3000);

// Logical environment (independent of NODE_ENV which is mostly about
// optimization). Set APP_ENV=staging on the Railway staging service so
// /health reports it and downstream code can branch when needed.
const APP_ENV = (process.env.APP_ENV || "production").toLowerCase();
const IS_STAGING    = APP_ENV === "staging";
const IS_PRODUCTION = APP_ENV === "production";

const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const LIVEKIT_URL        = process.env.LIVEKIT_URL        || "wss://osextolugar-eqa7q1iz.livekit.cloud";

const S3_ACCESS_KEY        = process.env.S3_ACCESS_KEY        || "";
const S3_SECRET_KEY        = process.env.S3_SECRET_KEY        || "";
const S3_BUCKET            = process.env.S3_BUCKET            || "";
const S3_REGION            = process.env.S3_REGION            || "auto";
const S3_ENDPOINT          = process.env.S3_ENDPOINT          || "";
const S3_PUBLIC_URL        = process.env.S3_PUBLIC_URL        || "";
const RECORDING_LAYOUT_URL = process.env.RECORDING_LAYOUT_URL || "https://preludiojogos.com/recording-layout.html";

// Mercado Pago — tokens separados por produto (Prelúdio Jogos vs Espaço
// Prelúdio). Cada um aponta pra uma aplicação MP distinta no painel do
// desenvolvedor (mercadopago.com.br/developers/panel/app).
// Permite que dinheiro de jogo e de telessaúde caia em contas MP separadas.
//
// Fallback: se MP_ACCESS_TOKEN_X específico não estiver setado, usa
// MP_ACCESS_TOKEN legado — backwards-compat pra deploys que ainda usam
// uma conta MP só. Remover o legado quando ambas contas estiverem migradas.
const MP_ACCESS_TOKEN_JOGO     = process.env.MP_ACCESS_TOKEN_JOGO     || process.env.MP_ACCESS_TOKEN    || "";
const MP_ACCESS_TOKEN_THERAPY  = process.env.MP_ACCESS_TOKEN_THERAPY  || process.env.MP_ACCESS_TOKEN    || "";
// Webhook secret idem — separado por produto (cada app MP gera o seu).
const MP_WEBHOOK_SECRET_JOGO    = process.env.MP_WEBHOOK_SECRET_JOGO    || process.env.MP_WEBHOOK_SECRET || "";
const MP_WEBHOOK_SECRET_THERAPY = process.env.MP_WEBHOOK_SECRET_THERAPY || process.env.MP_WEBHOOK_SECRET || "";

// Aliases legados — apontam pro jogo. Mantidos pra não quebrar imports
// existentes (routes/payments.js, routes/license.js, services/payments.js).
const MP_ACCESS_TOKEN   = MP_ACCESS_TOKEN_JOGO;
const MP_WEBHOOK_SECRET = MP_WEBHOOK_SECRET_JOGO;

// Webhook do Asaas (cobranças do financeiro do terapeuta). Token compartilhado
// — cada terapeuta configura no painel Asaas a URL `.../webhooks/asaas/financeiro?token=<x>`.
// Falhar em validar = 401, sem leak de info sobre transação.
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || "";

// Web Push (VAPID). Gerar uma vez com `npx web-push generate-vapid-keys`
// e salvar nas env vars do Railway. Subject pode ser mailto:contato@.
// Se vazio, /therapy/push/* respondem 503 sem quebrar app.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || "mailto:contato@espacopreludio.com.br";

// Sem default previsível: melhor recusar (fail-closed, ver signPayload/
// verifySignedToken em services/auth.js) do que assinar tokens com um
// segredo público no código-fonte.
const LICENSE_SECRET      = process.env.LICENSE_SECRET      || "";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const BACKEND_BASE_URL  = process.env.BACKEND_BASE_URL  || "https://osl-video-server-production.up.railway.app";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://preludiojogos.com";

const PRODUCT_ID       = "osl_ritual_completo";
const PRODUCT_TITLE    = "SEXTOLUGAR — Ritual Completo";
const PRODUCT_PRICE    = 29.9;
const PRODUCT_CURRENCY = "BRL";

const PRODUCT_CATALOG = {
  "osl_ritual_completo": {
    title: "SEXTOLUGAR — Ritual Completo",
    description: "Experiência digital imersiva com cartas psicológicas e interação em grupo ao vivo",
    price: 29.90,
    type: "license"
  },
  "carta-bloqueada": {
    title: "SEXTOLUGAR — Carta Desbloqueada",
    description: "Desbloqueie a próxima carta da sessão",
    price: 2.90,
    type: "consumable"
  },
  "carta-final": {
    title: "SEXTOLUGAR — Carta de Revelação Final",
    description: "Carta especial de revelação final para a sessão",
    price: 4.90,
    type: "consumable"
  },
  "segunda-chance": {
    title: "SEXTOLUGAR — Segunda Chance",
    description: "Continue a sessão com mais 3 cartas",
    price: 1.90,
    type: "consumable"
  },
  "gravacao-download": {
    title: "SEXTOLUGAR — Gravação + Download",
    description: "Grave sua sessão e baixe o arquivo MP4",
    price: 6.90,
    type: "consumable"
  },
  "gravacao-mensal": {
    title: "SEXTOLUGAR — Gravação Livre Mensal",
    description: "Grave sessões ilimitadas por 30 dias",
    price: 14.90,
    type: "subscription"
  },
  "streaming-mensal": {
    title: "SEXTOLUGAR — Stream Pass Mensal",
    description: "Transmita ao vivo (YouTube, Twitch, Facebook, Kick, TikTok) sem limite por 30 dias",
    price: 14.90,
    type: "subscription"
  },
  "sala-premium": {
    title: "SEXTOLUGAR — Sala Premium",
    description: "Sala premium com recursos avançados",
    price: 4.90,
    type: "consumable"
  },
  "modo-ritual": {
    title: "SEXTOLUGAR — Modo Ritual",
    description: "Sessão em Modo Ritual com trilha e rituais guiados",
    price: 6.90,
    type: "consumable"
  },
  "pacote-conexao": {
    title: "SEXTOLUGAR — Pacote Conexão",
    description: "12 cartas leves e emocionais para conexão genuína",
    price: 9.90,
    type: "pack"
  },
  "pacote-verdades": {
    title: "SEXTOLUGAR — Pacote Verdades",
    description: "15 cartas de verdades com desconforto leve",
    price: 12.90,
    type: "pack"
  },
  "pacote-conflito": {
    title: "SEXTOLUGAR — Pacote Conflito",
    description: "15 cartas de provocações e conflito honesto",
    price: 14.90,
    type: "pack"
  },
  "pacote-segredos": {
    title: "SEXTOLUGAR — Pacote Segredos",
    description: "18 cartas intensas e psicológicas",
    price: 19.90,
    type: "pack"
  },
  "pacote-casais": {
    title: "SEXTOLUGAR — Pacote Casais",
    description: "18 cartas nichadas para casais",
    price: 300.00,
    type: "pack"
  },
  "tema-sala": {
    title: "SEXTOLUGAR — Tema da Sala",
    description: "Personalização visual da sala",
    price: 4.90,
    type: "cosmetic"
  },
  "estilo-carta": {
    title: "SEXTOLUGAR — Estilo das Cartas",
    description: "Estilo visual personalizado para as cartas",
    price: 3.90,
    type: "cosmetic"
  },
  "efeitos-visuais": {
    title: "SEXTOLUGAR — Efeitos Visuais",
    description: "Efeitos visuais especiais na sala",
    price: 2.90,
    type: "cosmetic"
  },
  "coins_150": {
    title: "SEXTOLUGAR — Pacote Explorador",
    description: "150 moedas para usar na loja do jogo",
    price: 4.90,
    type: "coins",
    coins: 150
  },
  "coins_500": {
    title: "SEXTOLUGAR — Pacote Aliado",
    description: "500 moedas para usar na loja do jogo",
    price: 12.90,
    type: "coins",
    coins: 500
  },
  "coins_1500": {
    title: "SEXTOLUGAR — Pacote Mestre",
    description: "1.500 moedas para usar na loja do jogo",
    price: 29.90,
    type: "coins",
    coins: 1500
  },
  "encontro-ingresso": {
    title: "Prelúdio Jogos — Encontro Marcado",
    description: "Ingresso para o Speed Dating online quinzenal — 4 minutos com cada parceiro(a)",
    price: 15.00,
    type: "event_ticket"
  }
};

const LICENSE_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ACCESS_VALIDITY_MS  = 8 * 60 * 60 * 1000;
const PASS_VALIDITY_MS    = 30 * 24 * 60 * 60 * 1000; // recording_passes / streaming_passes
const FREE_TIER_DAILY_LIMIT_MIN = 60;                  // streaming free tier
const MAX_PLATFORMS_PER_STREAM = 5;                    // cap pra prevenir abuso de Egress
const MAX_COMPLETED_RECORDINGS_IN_MEMORY = 100;

const REFERRAL_REWARD_COINS        = 10;
const REFERRAL_MIN_WITHDRAW_COINS  = 100;
const REFERRAL_WITHDRAW_PIX_VALUE  = 90;
const REFERRAL_COMMISSION_PERCENT  = 0.31;

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// TOTP (2FA) para o painel admin. Gere um secret com:
//   node -e "console.log(require('crypto').randomBytes(20).toString('base64url'))"
// e converta para base32. Sem essa var, o 2FA é ignorado (backward-compat).
const PANEL_TOTP_SECRET = process.env.PANEL_TOTP_SECRET || "";

// Allowlist de e-mails admin do Espaço Prelúdio (verificação de CRP/CRM, etc).
// Comma-separated. Ex.: "luis@x.com,ops@y.com". Validado contra decoded.email
// do Firebase ID Token. Sem essa env, ninguém é admin (rejeita 403).
const THERAPY_ADMIN_EMAILS = String(process.env.THERAPY_ADMIN_EMAILS || "")
  .toLowerCase()
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Plano Pro do Espaço Prelúdio — preapproval recorrente MercadoPago.
// Tiers ativos:
//   - "profissional"  (R$ 99,00)  — profissional habilitado com mensalidade
//   - "empresa"       (R$ 0,00)   — gratuito pro profissional; consultas a R$60 cobradas ao paciente
// THERAPY_PLAN_AMOUNT mantido por compat (default sem flag explícita).
const THERAPY_PLAN_AMOUNT                 = Number(process.env.THERAPY_PLAN_AMOUNT                || 99.00);
const THERAPY_PLAN_RECEM_FORMADO_AMOUNT   = Number(process.env.THERAPY_PLAN_RECEM_FORMADO_AMOUNT  || 99.00); // legado
const THERAPY_PLAN_PROFISSIONAL_AMOUNT    = Number(process.env.THERAPY_PLAN_PROFISSIONAL_AMOUNT   || 99.00);
const THERAPY_PLAN_EMPRESA_AMOUNT         = Number(process.env.THERAPY_PLAN_EMPRESA_AMOUNT        || 0.00);
const THERAPY_PLAN_EMPRESA_SESSION_AMOUNT = Number(process.env.THERAPY_PLAN_EMPRESA_SESSION_AMOUNT || 60.00);
// Cobrança anual = mensal x 12 x 0.84 (16% de desconto), preapproval com
// frequency: 12 / frequency_type: "months" (MP não tem frequency_type "years").
const THERAPY_PLAN_ANNUAL_AMOUNT               = Number(process.env.THERAPY_PLAN_ANNUAL_AMOUNT               || 997.92);
const THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT = Number(process.env.THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT || 997.92); // legado
const THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT  = Number(process.env.THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT  || 997.92);
const THERAPY_PLAN_NAME       = process.env.THERAPY_PLAN_NAME       || "Espaço Prelúdio Pro";

// Trial diferenciado por plano intencionado no cadastro:
//   - "estudante"     →  0 dias (irrelevante: vira student-active após validar doc)
//   - "recem-formado" → 30 dias (1 mês pra validar inscrição + decidir contratar)
//   - "profissional"  → 30 dias (período de teste padrão)
//   - default         → 30 dias (cadastros sem flag explícita = profissional)
// THERAPY_TRIAL_DAYS mantido por compat — usado se intendedTier não vier.
const THERAPY_TRIAL_DAYS      = Number(process.env.THERAPY_TRIAL_DAYS || 30);
const THERAPY_TRIAL_DAYS_PROFISSIONAL  = Number(process.env.THERAPY_TRIAL_DAYS_PROFISSIONAL  || 30);
const THERAPY_TRIAL_DAYS_RECEM_FORMADO = Number(process.env.THERAPY_TRIAL_DAYS_RECEM_FORMADO || 30);
const THERAPY_FRONTEND_BASE   = process.env.THERAPY_FRONTEND_BASE   || "https://espacopreludio.com.br";
// Janela mínima (em horas) para o paciente cancelar uma sessão futura. Abaixo
// disso, só o terapeuta pode cancelar. Default 24h alinha com a expectativa
// clínica usual de "no-show fee" em terapia.
const THERAPY_MIN_CANCEL_HOURS_PATIENT = Number(process.env.THERAPY_MIN_CANCEL_HOURS_PATIENT || 24);

// E-mail (provider Resend, https://resend.com). Se RESEND_API_KEY vazio, o
// service vira no-op com log warn — funcionalidade de confirmação/lembrete
// degrada silenciosamente sem quebrar criação de sessão.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM     = process.env.EMAIL_FROM     || "Espaço Prelúdio <agendas@espacopreludio.com.br>";
// Janela do cron de lembretes: lookahead em horas (procura sessões cujo
// scheduledAt cai entre now+lookahead-1h e now+lookahead). 24h por default;
// 1h de janela permite que o cron rode 1×/h sem perder eventos.
const REMINDER_LOOKAHEAD_HOURS = Number(process.env.REMINDER_LOOKAHEAD_HOURS || 24);

// ─── WhatsApp via Z-API ──────────────────────────────────────────────────
// Provider: https://z-api.io — número único da plataforma envia mensagens
// (confirmação, lembrete, cancelamento) pros pacientes. Custo mensal fixo
// absorvido no plano Pro.
//
// Setup: criar instância no painel Z-API, parear número 48988637670 via
// QR code, pegar instanceId + clientToken + securityToken aqui:
//   https://app.z-api.io/instances
// Webhook de recebimento (opcional): aponta pra
//   ${BACKEND_BASE_URL}/therapy/webhook/zapi
// Se ZAPI_INSTANCE_ID vazio, services/whatsapp.js vira no-op com log
// silencioso — funcionalidade degrada sem quebrar criação de sessão.
const ZAPI_INSTANCE_ID    = process.env.ZAPI_INSTANCE_ID    || "";
const ZAPI_CLIENT_TOKEN   = process.env.ZAPI_CLIENT_TOKEN   || "";
const ZAPI_SECURITY_TOKEN = process.env.ZAPI_SECURITY_TOKEN || "";
const ZAPI_BASE_URL       = process.env.ZAPI_BASE_URL       || "https://api.z-api.io";

const DISCORD_CLIENT_ID       = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET   = process.env.DISCORD_CLIENT_SECRET   || "";
const DISCORD_BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN       || "";
const DISCORD_GUILD_ID        = process.env.DISCORD_GUILD_ID        || "";
const DISCORD_REDIRECT_URI    = process.env.DISCORD_REDIRECT_URI    || `${BACKEND_BASE_URL}/discord/callback`;
const DISCORD_ROLE_BUYER_ID      = process.env.DISCORD_ROLE_BUYER_ID      || "";
const DISCORD_ROLE_AFFILIATE_ID  = process.env.DISCORD_ROLE_AFFILIATE_ID  || "";
const DISCORD_API_BASE = "https://discord.com/api/v10";

// Twilio — WhatsApp notifications para profissionais
const TWILIO_ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID    || "";
const TWILIO_AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN     || "";
// Número WhatsApp Business aprovado pela Meta (ex: "whatsapp:+14155238886")
// Fica vazio até a aprovação chegar — o serviço vira no-op enquanto não estiver configurado.
const TWILIO_WHATSAPP_FROM  = process.env.TWILIO_WHATSAPP_FROM  || "";

// Painel corporativo — JWT secret para autenticação de empresas (separado do
// Firebase). Sem default previsível — ver fail-closed em gerarEmpresaToken/
// verificarEmpresaToken (routes/therapy.js).
const EMPRESA_JWT_SECRET = process.env.EMPRESA_JWT_SECRET || "";

module.exports = {
  PORT,
  APP_ENV, IS_STAGING, IS_PRODUCTION,
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_PUBLIC_URL,
  RECORDING_LAYOUT_URL,
  MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET,
  MP_ACCESS_TOKEN_JOGO, MP_ACCESS_TOKEN_THERAPY,
  MP_WEBHOOK_SECRET_JOGO, MP_WEBHOOK_SECRET_THERAPY,
  ASAAS_WEBHOOK_TOKEN,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
  EMPRESA_JWT_SECRET,
  LICENSE_SECRET, ACCESS_TOKEN_SECRET,
  ANTHROPIC_API_KEY,
  BACKEND_BASE_URL, FRONTEND_BASE_URL,
  PRODUCT_ID, PRODUCT_TITLE, PRODUCT_PRICE, PRODUCT_CURRENCY,
  PRODUCT_CATALOG,
  LICENSE_VALIDITY_MS, ACCESS_VALIDITY_MS, PASS_VALIDITY_MS,
  FREE_TIER_DAILY_LIMIT_MIN, MAX_PLATFORMS_PER_STREAM, MAX_COMPLETED_RECORDINGS_IN_MEMORY,
  REFERRAL_REWARD_COINS, REFERRAL_MIN_WITHDRAW_COINS, REFERRAL_WITHDRAW_PIX_VALUE, REFERRAL_COMMISSION_PERCENT,
  ADMIN_SECRET, PANEL_TOTP_SECRET,
  THERAPY_ADMIN_EMAILS,
  THERAPY_PLAN_AMOUNT, THERAPY_PLAN_RECEM_FORMADO_AMOUNT, THERAPY_PLAN_PROFISSIONAL_AMOUNT,
  THERAPY_PLAN_ANNUAL_AMOUNT, THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT, THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT,
  THERAPY_PLAN_NAME,
  THERAPY_TRIAL_DAYS, THERAPY_TRIAL_DAYS_PROFISSIONAL, THERAPY_TRIAL_DAYS_RECEM_FORMADO,
  THERAPY_FRONTEND_BASE,
  THERAPY_MIN_CANCEL_HOURS_PATIENT,
  RESEND_API_KEY, EMAIL_FROM, REMINDER_LOOKAHEAD_HOURS,
  ZAPI_INSTANCE_ID, ZAPI_CLIENT_TOKEN, ZAPI_SECURITY_TOKEN, ZAPI_BASE_URL,
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID,
  DISCORD_REDIRECT_URI, DISCORD_ROLE_BUYER_ID, DISCORD_ROLE_AFFILIATE_ID, DISCORD_API_BASE
};
