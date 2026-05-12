// services/whatsapp.js
//
// Integração com Z-API (https://z-api.io) — provider brasileiro que abstrai
// WhatsApp via pareamento por QR code. Custo mensal fixo (~R$ 200-400)
// absorvido no plano Pro do Espaço Prelúdio.
//
// O número único da plataforma (48988637670, configurado no painel Z-API)
// envia 3 tipos de mensagem pros pacientes:
//   - confirmação (ao criar consulta)
//   - lembrete (24h antes — disparado pelo services/scheduler.js)
//   - cancelamento (após sessão cancelada)
//
// Configuração por profissional vive em therapists/{uid}.whatsappConfig:
//   {
//     enabled: boolean,
//     clinicName: string (aparece na assinatura da mensagem),
//     phoneClinic: string (telefone que o paciente pode ligar — paciente
//                          não responde direto ao número de envio),
//     templates: {
//       confirmacao: string,
//       lembrete: string,
//       cancelamento: string
//     }
//   }
//
// Templates aceitam placeholders {{var}} substituídos em tempo de envio.
// Variáveis disponíveis: {{paciente}}, {{profissional}}, {{data}}, {{hora}},
// {{link_confirmar}}, {{link_cancelar}}, {{telefone_clinica}},
// {{nome_clinica}}.
//
// Se ZAPI_INSTANCE_ID vazio (env vars não configurados ainda), todas as
// funções viram no-op com log silencioso. Não bloqueia outras features.

const { httpFetch } = require("../utils");
const { logInfo, logWarn, logError } = require("../logger");
const {
  ZAPI_INSTANCE_ID, ZAPI_CLIENT_TOKEN, ZAPI_SECURITY_TOKEN, ZAPI_BASE_URL
} = require("../config");

// Templates padrão. Cada profissional pode sobrescrever via PATCH no perfil.
// Mantemos o branding "Espaço Prelúdio" como rodapé fixo do app (vai ser
// adicionado abaixo do template do profissional, não no template em si).
const DEFAULT_TEMPLATES = {
  confirmacao:
`Olá, {{paciente}}! Sua consulta com {{profissional}} foi confirmada para {{data}} às {{hora}}.

Confirmar presença: {{link_confirmar}}
Não vou poder ir: {{link_cancelar}}

Dúvidas? Ligue: {{telefone_clinica}}
— {{nome_clinica}}`,

  lembrete:
`Olá, {{paciente}}! Lembrete: sua consulta com {{profissional}} é amanhã, {{data}} às {{hora}}.

Confirmar presença: {{link_confirmar}}
Cancelar: {{link_cancelar}}

— {{nome_clinica}}`,

  cancelamento:
`Olá, {{paciente}}. Sua consulta com {{profissional}} agendada para {{data}} foi cancelada.

Pra reagendar, fale conosco: {{telefone_clinica}}
— {{nome_clinica}}`
};

const PHONE_DIGITS_RX = /\D+/g;

// Normaliza número pra formato E.164 sem o "+" (que o Z-API aceita):
// "48988637670" → "5548988637670"
// "(48) 98863-7670" → "5548988637670"
// "+5548988637670" → "5548988637670"
// Sem código de país: assume Brasil (+55).
function normalizePhone(input) {
  let digits = String(input || "").replace(PHONE_DIGITS_RX, "");
  if (!digits) return "";
  // Já tem 55 (BR): mantém
  if (digits.length >= 12 && digits.startsWith("55")) return digits;
  // 10 ou 11 dígitos: assume BR
  if (digits.length === 10 || digits.length === 11) return "55" + digits;
  // Outros: devolve como está, Z-API valida no envio
  return digits;
}

// Substitui {{var}} no template pelos valores fornecidos. Variáveis não
// fornecidas viram string vazia (não quebra envio).
function applyTemplate(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars?.[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

// True se há credenciais configuradas — usado por handlers pra evitar
// chamar Z-API quando ambiente não está pronto (no-op silencioso).
function isConfigured() {
  return Boolean(ZAPI_INSTANCE_ID && ZAPI_CLIENT_TOKEN && ZAPI_SECURITY_TOKEN);
}

// Envia texto livre via Z-API. Retorna { ok, skipped?, messageId?, error? }.
// Não joga exceção — caller continua mesmo se WhatsApp falhar.
//
// Z-API endpoint: POST /instances/{id}/token/{clientToken}/send-text
// Headers: Client-Token: {securityToken}
// Body: { phone, message }
async function sendText({ to, message }) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: "ZAPI_NAO_CONFIGURADO" };
  }
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: "TELEFONE_INVALIDO" };
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "MENSAGEM_VAZIA" };

  const url = `${ZAPI_BASE_URL}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}/token/${encodeURIComponent(ZAPI_CLIENT_TOKEN)}/send-text`;
  try {
    const res = await httpFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": ZAPI_SECURITY_TOKEN
      },
      body: JSON.stringify({ phone, message: msg })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logWarn("zapi_send_failed", { status: res.status, phone, data });
      return { ok: false, error: data?.error || `HTTP_${res.status}`, data };
    }
    logInfo("zapi_send_ok", { phone, messageId: data?.messageId || data?.id || null });
    return { ok: true, messageId: data?.messageId || data?.id || null, data };
  } catch (err) {
    logError("zapi_send_exception", err, { phone });
    return { ok: false, error: err.message || "NETWORK" };
  }
}

// Verifica status da instância (conectada/desconectada). Útil pra UI
// mostrar status no perfil. Sem credenciais: retorna { connected: false,
// reason: "NAO_CONFIGURADO" }.
async function getInstanceStatus() {
  if (!isConfigured()) {
    return { connected: false, reason: "NAO_CONFIGURADO" };
  }
  const url = `${ZAPI_BASE_URL}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}/token/${encodeURIComponent(ZAPI_CLIENT_TOKEN)}/status`;
  try {
    const res = await httpFetch(url, {
      headers: { "Client-Token": ZAPI_SECURITY_TOKEN }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { connected: false, reason: `HTTP_${res.status}`, data };
    return {
      connected: Boolean(data?.connected),
      smartphoneConnected: Boolean(data?.smartphoneConnected),
      data
    };
  } catch (err) {
    return { connected: false, reason: err.message || "NETWORK" };
  }
}

// Helpers high-level que combinam template + vars + sendText.
// Caller passa o objeto session + therapist; nós montamos a mensagem.

// Resolve template efetivo: usa o customizado do profissional se houver,
// senão cai no DEFAULT_TEMPLATES.
function resolveTemplate(whatsappConfig, kind) {
  const custom = whatsappConfig?.templates?.[kind];
  return (custom && custom.trim()) || DEFAULT_TEMPLATES[kind];
}

// Formata timestamp pra date+time pt-BR separadamente. Usado nos templates.
function formatBR(ms) {
  const d = new Date(ms);
  const data = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return { data, hora };
}

// Constrói o set de variáveis padrão pra substituição em template.
function buildVars({ session, therapist, joinUrl, cancelUrl }) {
  const wa = therapist?.whatsappConfig || {};
  const { data, hora } = session?.scheduledAt
    ? formatBR(session.scheduledAt)
    : { data: "—", hora: "—" };
  return {
    paciente: session?.patientName || "",
    profissional: therapist?.displayName || "",
    data,
    hora,
    link_confirmar: joinUrl || "",
    link_cancelar:  cancelUrl || "",
    telefone_clinica: wa.phoneClinic || "",
    nome_clinica:     wa.clinicName  || therapist?.displayName || ""
  };
}

// Envia confirmação ao criar consulta. Caller já passou as URLs assinadas.
async function sendConfirmation({ session, therapist, joinUrl, cancelUrl }) {
  if (!therapist?.whatsappConfig?.enabled) return { ok: false, skipped: true, reason: "WA_DESATIVADO" };
  if (!session?.patientPhone) return { ok: false, skipped: true, reason: "SEM_TELEFONE" };
  const tpl  = resolveTemplate(therapist.whatsappConfig, "confirmacao");
  const vars = buildVars({ session, therapist, joinUrl, cancelUrl });
  const message = applyTemplate(tpl, vars);
  return sendText({ to: session.patientPhone, message });
}

async function sendReminder({ session, therapist, joinUrl, cancelUrl }) {
  if (!therapist?.whatsappConfig?.enabled) return { ok: false, skipped: true, reason: "WA_DESATIVADO" };
  if (!session?.patientPhone) return { ok: false, skipped: true, reason: "SEM_TELEFONE" };
  const tpl  = resolveTemplate(therapist.whatsappConfig, "lembrete");
  const vars = buildVars({ session, therapist, joinUrl, cancelUrl });
  const message = applyTemplate(tpl, vars);
  return sendText({ to: session.patientPhone, message });
}

async function sendCancellation({ session, therapist }) {
  if (!therapist?.whatsappConfig?.enabled) return { ok: false, skipped: true, reason: "WA_DESATIVADO" };
  if (!session?.patientPhone) return { ok: false, skipped: true, reason: "SEM_TELEFONE" };
  const tpl  = resolveTemplate(therapist.whatsappConfig, "cancelamento");
  const vars = buildVars({ session, therapist, joinUrl: "", cancelUrl: "" });
  const message = applyTemplate(tpl, vars);
  return sendText({ to: session.patientPhone, message });
}

module.exports = {
  DEFAULT_TEMPLATES,
  normalizePhone,
  applyTemplate,
  isConfigured,
  sendText,
  getInstanceStatus,
  sendConfirmation,
  sendReminder,
  sendCancellation,
  resolveTemplate,
  buildVars,
  formatBR
};
