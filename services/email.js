// Envio de e-mail transacional via Resend (https://resend.com).
//
// Modo no-op: se RESEND_API_KEY vazio, sendEmail() loga warn e retorna
// { ok: false, skipped: true } sem disparar erro. Isso é proposital —
// criação de sessão não deve quebrar quando a infra de e-mail não está
// configurada (ex.: ambiente local).
//
// Templates aqui são minimalistas e em pt-BR. HTML inline (sem framework)
// porque clientes de e-mail rejeitam <link>/<style> em <head> ou aplicam
// inconsistente. Compromisso: funciona em Gmail/Outlook/Apple Mail sem
// hacks adicionais.

const { logInfo, logWarn, logError } = require("../logger");
const { RESEND_API_KEY, EMAIL_FROM, THERAPY_FRONTEND_BASE } = require("../config");

const RESEND_API_URL = "https://api.resend.com/emails";

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDateTimePtBR(ms) {
  return new Date(ms).toLocaleString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long",
    hour: "2-digit", minute: "2-digit",
    timeZone: "America/Sao_Paulo"
  });
}

// "Hoje", "amanhã" ou "em N dias" no fuso brasileiro. Usado no subject e
// headline do lembrete pra não dizer "amanhã" quando o cron pega uma
// sessão que é em 30min, ou quando alguém futuramente reduzir o
// REMINDER_LOOKAHEAD_HOURS.
function describeWhenPtBR(scheduledAt) {
  const diffMs = scheduledAt - Date.now();
  if (diffMs < 0)                       return "agora";
  if (diffMs < 2 * 60 * 60 * 1000)      return "em breve";

  // Comparar dia-calendário em America/Sao_Paulo, não UTC do servidor.
  const ymdAt  = new Date(scheduledAt).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const ymdNow = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  if (ymdAt === ymdNow) return "hoje";

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ymdTomorrow = tomorrow.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  if (ymdAt === ymdTomorrow) return "amanhã";

  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  return `em ${days} dias`;
}

async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!RESEND_API_KEY) {
    logWarn("email_skipped_no_api_key", { to, subject });
    return { ok: false, skipped: true };
  }
  if (!to) {
    logWarn("email_skipped_no_recipient", { subject });
    return { ok: false, skipped: true };
  }

  // Resend aceita reply_to como string ou array de strings. Quando paciente
  // aperta Reply, e-mail vai pra esse endereço (o do terapeuta dono da
  // sessão), não pro from (que não tem inbox).
  const payload = { from: EMAIL_FROM, to, subject, html, text };
  if (replyTo) payload.reply_to = replyTo;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logError("email_send_failed", new Error(data?.message || `HTTP ${res.status}`), { to, subject });
      return { ok: false, status: res.status };
    }
    logInfo("email_sent", { to, subject, id: data?.id });
    return { ok: true, id: data?.id };
  } catch (error) {
    logError("email_send_exception", error, { to, subject });
    return { ok: false, error: error.message };
  }
}

// ─── Templates ──────────────────────────────────────────────────────────

function renderShell({ heading, bodyHtml, footer }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:24px; background:#f7f4ef; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#1c1f1d;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden;">
    <tr><td style="padding:24px 28px 20px; border-bottom:1px solid rgba(28,31,29,0.08);">
      <div style="font-size:13px; letter-spacing:0.06em; text-transform:uppercase; color:rgba(28,31,29,0.55);">Espaço Prelúdio</div>
      <h1 style="font-size:20px; font-weight:600; margin:8px 0 0;">${escHtml(heading)}</h1>
    </td></tr>
    <tr><td style="padding:24px 28px; font-size:15px; line-height:1.55;">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:18px 28px 24px; font-size:12px; color:rgba(28,31,29,0.50); border-top:1px solid rgba(28,31,29,0.06);">
      ${footer || "Este e-mail foi enviado automaticamente pelo Espaço Prelúdio."}
    </td></tr>
  </table>
</body>
</html>`;
}

function templateConfirmation({ patientName, therapistName, scheduledAt, joinUrl, cancelUrl }) {
  const subject = `Sua consulta com ${therapistName} foi agendada`;
  const when = fmtDateTimePtBR(scheduledAt);
  const html = renderShell({
    heading: "Consulta agendada",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName)},</p>
      <p style="margin:0 0 16px;">Sua consulta com <strong>${escHtml(therapistName)}</strong> foi marcada para:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-weight:500;">${escHtml(when)}</p>
      <p style="margin:0 0 20px;">No horário, entre na sessão por este link:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(joinUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Entrar na consulta</a></p>
      ${cancelUrl ? `<p style="margin:0 0 8px; font-size:13px; color:rgba(28,31,29,0.65);">Precisa cancelar? <a href="${escHtml(cancelUrl)}" style="color:rgba(28,31,29,0.65);">Use este link</a> com pelo menos 24h de antecedência.</p>` : ""}
    `,
    footer: "Você recebeu este e-mail porque foi marcada uma consulta para você no Espaço Prelúdio. Se isso não foi você, ignore."
  });
  const text = `Olá ${patientName},\n\nSua consulta com ${therapistName} foi marcada para ${when}.\n\nLink para entrar: ${joinUrl}\n${cancelUrl ? `Cancelar: ${cancelUrl} (com 24h de antecedência)\n` : ""}\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateReminder({ patientName, therapistName, scheduledAt, joinUrl, cancelUrl }) {
  const relativeWhen = describeWhenPtBR(scheduledAt);
  const subject = `Lembrete: sua consulta ${relativeWhen}`;
  const headingByWhen = {
    "agora":     "Sua consulta é agora",
    "em breve":  "Sua consulta começa em breve",
    "hoje":      "Sua consulta é hoje",
    "amanhã":    "Sua consulta é amanhã"
  };
  const heading = headingByWhen[relativeWhen] || `Sua consulta ${relativeWhen}`;
  const when = fmtDateTimePtBR(scheduledAt);
  const html = renderShell({
    heading,
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName)},</p>
      <p style="margin:0 0 16px;">Lembrete: você tem consulta com <strong>${escHtml(therapistName)}</strong> em:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-weight:500;">${escHtml(when)}</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(joinUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Entrar na consulta</a></p>
      ${cancelUrl ? `<p style="margin:0 0 0; font-size:13px; color:rgba(28,31,29,0.65);">Não vai conseguir? Use este <a href="${escHtml(cancelUrl)}" style="color:rgba(28,31,29,0.65);">link de cancelamento</a> ou avise diretamente o profissional.</p>` : ""}
    `,
    footer: "Lembrete enviado automaticamente pelo Espaço Prelúdio."
  });
  const text = `Lembrete: você tem consulta com ${therapistName} em ${when}.\n\nLink para entrar: ${joinUrl}\n${cancelUrl ? `Cancelar: ${cancelUrl}\n` : ""}\nEspaço Prelúdio`;
  return { subject, html, text };
}

// ─── Helpers de URL ─────────────────────────────────────────────────────

function buildJoinUrl(joinToken) {
  return `${THERAPY_FRONTEND_BASE}/entrar.html?t=${encodeURIComponent(joinToken)}`;
}
function buildCancelUrl(cancelToken) {
  return `${THERAPY_FRONTEND_BASE}/cancelar.html?t=${encodeURIComponent(cancelToken)}`;
}

module.exports = {
  sendEmail,
  templateConfirmation,
  templateReminder,
  buildJoinUrl,
  buildCancelUrl
};
