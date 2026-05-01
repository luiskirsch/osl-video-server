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
const RECORDING_LAYOUT_URL = process.env.RECORDING_LAYOUT_URL || "https://preludiojogos.com.br/recording-layout.html";

const MP_ACCESS_TOKEN    = process.env.MP_ACCESS_TOKEN    || "";
const MP_WEBHOOK_SECRET  = process.env.MP_WEBHOOK_SECRET  || ""; // Security #1: pra validar x-signature

const LICENSE_SECRET      = process.env.LICENSE_SECRET      || "TROQUE_POR_UM_SEGREDO_FORTE_DA_LICENCA";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "TROQUE_POR_UM_SEGREDO_FORTE_DE_ACESSO";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const BACKEND_BASE_URL  = process.env.BACKEND_BASE_URL  || "https://osl-video-server-production.up.railway.app";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://preludiojogos.com.br";

const PRODUCT_ID       = "osl_ritual_completo";
const PRODUCT_TITLE    = "O SextoLugar — Ritual Completo";
const PRODUCT_PRICE    = 29.9;
const PRODUCT_CURRENCY = "BRL";

const PRODUCT_CATALOG = {
  "osl_ritual_completo": {
    title: "O SextoLugar — Ritual Completo",
    description: "Experiência digital imersiva com cartas psicológicas e interação em grupo ao vivo",
    price: 29.90,
    type: "license"
  },
  "carta-bloqueada": {
    title: "O SextoLugar — Carta Desbloqueada",
    description: "Desbloqueie a próxima carta da sessão",
    price: 2.90,
    type: "consumable"
  },
  "carta-final": {
    title: "O SextoLugar — Carta de Revelação Final",
    description: "Carta especial de revelação final para a sessão",
    price: 4.90,
    type: "consumable"
  },
  "segunda-chance": {
    title: "O SextoLugar — Segunda Chance",
    description: "Continue a sessão com mais 3 cartas",
    price: 1.90,
    type: "consumable"
  },
  "gravacao-download": {
    title: "O SextoLugar — Gravação + Download",
    description: "Grave sua sessão e baixe o arquivo MP4",
    price: 6.90,
    type: "consumable"
  },
  "gravacao-mensal": {
    title: "O SextoLugar — Gravação Livre Mensal",
    description: "Grave sessões ilimitadas por 30 dias",
    price: 14.90,
    type: "subscription"
  },
  "streaming-mensal": {
    title: "O SextoLugar — Stream Pass Mensal",
    description: "Transmita ao vivo (YouTube, Twitch, Facebook, Kick, TikTok) sem limite por 30 dias",
    price: 14.90,
    type: "subscription"
  },
  "sala-premium": {
    title: "O SextoLugar — Sala Premium",
    description: "Sala premium com recursos avançados",
    price: 4.90,
    type: "consumable"
  },
  "modo-ritual": {
    title: "O SextoLugar — Modo Ritual",
    description: "Sessão em Modo Ritual com trilha e rituais guiados",
    price: 6.90,
    type: "consumable"
  },
  "pacote-conexao": {
    title: "O SextoLugar — Pacote Conexão",
    description: "12 cartas leves e emocionais para conexão genuína",
    price: 9.90,
    type: "pack"
  },
  "pacote-verdades": {
    title: "O SextoLugar — Pacote Verdades",
    description: "15 cartas de verdades com desconforto leve",
    price: 12.90,
    type: "pack"
  },
  "pacote-conflito": {
    title: "O SextoLugar — Pacote Conflito",
    description: "15 cartas de provocações e conflito honesto",
    price: 14.90,
    type: "pack"
  },
  "pacote-segredos": {
    title: "O SextoLugar — Pacote Segredos",
    description: "18 cartas intensas e psicológicas",
    price: 19.90,
    type: "pack"
  },
  "pacote-casais": {
    title: "O SextoLugar — Pacote Casais",
    description: "18 cartas nichadas para casais",
    price: 19.90,
    type: "pack"
  },
  "tema-sala": {
    title: "O SextoLugar — Tema da Sala",
    description: "Personalização visual da sala",
    price: 4.90,
    type: "cosmetic"
  },
  "estilo-carta": {
    title: "O SextoLugar — Estilo das Cartas",
    description: "Estilo visual personalizado para as cartas",
    price: 3.90,
    type: "cosmetic"
  },
  "efeitos-visuais": {
    title: "O SextoLugar — Efeitos Visuais",
    description: "Efeitos visuais especiais na sala",
    price: 2.90,
    type: "cosmetic"
  }
};

const LICENSE_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ACCESS_VALIDITY_MS  = 8 * 60 * 60 * 1000;

const REFERRAL_REWARD_COINS        = 10;
const REFERRAL_MIN_WITHDRAW_COINS  = 100;
const REFERRAL_WITHDRAW_PIX_VALUE  = 90;
const REFERRAL_COMMISSION_PERCENT  = 0.31;

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const DISCORD_CLIENT_ID       = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET   = process.env.DISCORD_CLIENT_SECRET   || "";
const DISCORD_BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN       || "";
const DISCORD_GUILD_ID        = process.env.DISCORD_GUILD_ID        || "";
const DISCORD_REDIRECT_URI    = process.env.DISCORD_REDIRECT_URI    || `${BACKEND_BASE_URL}/discord/callback`;
const DISCORD_ROLE_BUYER_ID      = process.env.DISCORD_ROLE_BUYER_ID      || "";
const DISCORD_ROLE_AFFILIATE_ID  = process.env.DISCORD_ROLE_AFFILIATE_ID  || "";
const DISCORD_API_BASE = "https://discord.com/api/v10";

module.exports = {
  PORT,
  APP_ENV, IS_STAGING, IS_PRODUCTION,
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_PUBLIC_URL,
  RECORDING_LAYOUT_URL, MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET,
  LICENSE_SECRET, ACCESS_TOKEN_SECRET,
  ANTHROPIC_API_KEY,
  BACKEND_BASE_URL, FRONTEND_BASE_URL,
  PRODUCT_ID, PRODUCT_TITLE, PRODUCT_PRICE, PRODUCT_CURRENCY,
  PRODUCT_CATALOG,
  LICENSE_VALIDITY_MS, ACCESS_VALIDITY_MS,
  REFERRAL_REWARD_COINS, REFERRAL_MIN_WITHDRAW_COINS, REFERRAL_WITHDRAW_PIX_VALUE, REFERRAL_COMMISSION_PERCENT,
  ADMIN_SECRET,
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID,
  DISCORD_REDIRECT_URI, DISCORD_ROLE_BUYER_ID, DISCORD_ROLE_AFFILIATE_ID, DISCORD_API_BASE
};
