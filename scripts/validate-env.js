// Valida que todos os secrets críticos estão configurados.
// Exporta checkSecrets() para uso no startup do servidor.
// Quando executado diretamente (node scripts/validate-env.js --ci), roda e sai.

const IS_CI         = process.argv.includes("--ci") || process.env.CI_MODE === "true";
const IS_PRODUCTION = (process.env.APP_ENV || "production").toLowerCase() === "production";

// Ausência = falha de segurança imediata
const CRITICAL = [
  "ACCESS_TOKEN_SECRET",
  "LICENSE_SECRET",
  "ADMIN_SECRET",
  "EMPRESA_JWT_SECRET",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "MP_ACCESS_TOKEN_JOGO",
  "MP_WEBHOOK_SECRET_JOGO",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
];

// Ausência degrada funcionalidade mas não compromete segurança
const IMPORTANT = [
  "MP_ACCESS_TOKEN_THERAPY",
  "MP_WEBHOOK_SECRET_THERAPY",
  "ASAAS_WEBHOOK_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "PANEL_TOTP_SECRET",
  "ANTHROPIC_API_KEY",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "RESEND_API_KEY",
];

const MIN_SECRET_LENGTH = 32;

function checkSecrets({ exitOnError = false } = {}) {
  if (IS_CI) {
    // No CI não temos valores reais — só valida que o script existe e roda
    console.log(`[validate-env] CI mode OK — ${CRITICAL.length} críticos, ${IMPORTANT.length} importantes definidos.`);
    return { ok: true };
  }

  const missing = [];
  const weak    = [];
  const missingImportant = [];

  for (const name of CRITICAL) {
    const val = process.env[name];
    if (!val) missing.push(name);
    else if (val.length < MIN_SECRET_LENGTH) weak.push({ name, len: val.length });
  }

  for (const name of IMPORTANT) {
    if (!process.env[name]) missingImportant.push(name);
  }

  if (missing.length > 0) {
    console.error("[validate-env] CRITICO: secrets ausentes:", missing.join(", "));
    if (exitOnError) {
      console.error("[validate-env] Configure os secrets ausentes no Railway antes de iniciar em producao.");
      process.exit(1);
    }
  }

  for (const { name, len } of weak) {
    console.warn(`[validate-env] AVISO: ${name} tem apenas ${len} chars (min ${MIN_SECRET_LENGTH})`);
  }

  if (missingImportant.length > 0) {
    console.warn("[validate-env] AVISO: secrets importantes ausentes:", missingImportant.join(", "));
  }

  if (missing.length === 0) {
    console.log(`[validate-env] OK — ${CRITICAL.length} secrets críticos presentes.`);
  }

  return { ok: missing.length === 0, missing, weak, missingImportant };
}

// Execução direta: node scripts/validate-env.js [--ci]
if (require.main === module) {
  checkSecrets({ exitOnError: true });
}

module.exports = { checkSecrets };
