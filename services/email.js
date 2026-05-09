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

function templateDispensacaoNotice({
  therapistName, patientName, farmaciaNome, farmaciaCnpjFmt,
  farmaceuticoNome, farmaceuticoCRF, quantidade, totalPrescrito, restante, dispensadoAt
}) {
  const subject = restante > 0
    ? `Receita do paciente ${patientName} foi parcialmente dispensada`
    : `Receita do paciente ${patientName} foi totalmente dispensada`;
  const when = fmtDateTimePtBR(dispensadoAt);
  const restanteTxt = restante > 0
    ? `<strong>${restante} de ${totalPrescrito}</strong> ${restante === 1 ? "unidade restante" : "unidades restantes"}.`
    : `Saldo zerado — todas as ${totalPrescrito} ${totalPrescrito === 1 ? "unidade" : "unidades"} foram dispensadas.`;
  const html = renderShell({
    heading: "Receita dispensada",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Uma farmácia registrou dispensação da receita que você emitiu para <strong>${escHtml(patientName)}</strong>.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Quando</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(when)}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Quantidade dispensada</td><td style="padding:3px 0; text-align:right;"><strong>${quantidade} ${quantidade === 1 ? "unidade" : "unidades"}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Farmácia</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(farmaciaNome)}</strong><br><span style="font-size:12px; color:rgba(28,31,29,0.55);">${escHtml(farmaciaCnpjFmt)}</span></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Farmacêutico</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(farmaceuticoNome)}</strong><br><span style="font-size:12px; color:rgba(28,31,29,0.55);">${escHtml(farmaceuticoCRF)}</span></td></tr>
      </table>
      <p style="margin:0 0 8px;">${restanteTxt}</p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Esta notificação ajuda você a acompanhar a adesão do paciente ao tratamento. Em caso de irregularidade (CNPJ desconhecido, frequência atípica, etc.), entre em contato com o paciente diretamente ou registre ocorrência ao CRF/Vigilância Sanitária.</p>
    `,
    footer: "Notificação automática do Espaço Prelúdio sobre dispensação de receita controlada."
  });
  const text = `Olá ${therapistName},\n\nDispensação registrada para ${patientName}:\n- ${when}\n- ${quantidade} ${quantidade === 1 ? "unidade" : "unidades"}\n- ${farmaciaNome} (CNPJ ${farmaciaCnpjFmt})\n- ${farmaceuticoNome} (${farmaceuticoCRF})\n\n${restante > 0 ? `${restante} de ${totalPrescrito} restantes.` : `Saldo zerado.`}\n\nEspaço Prelúdio`;
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

// E-mail enviado quando admin aprova manualmente o comprovante de matrícula
// do tier estudante (caso o LLM tenha mandado pra fila de revisão).
function templateStudentApproved({ therapistName, validUntilMs, painelUrl }) {
  const subject = "Tier Estudante liberado no Espaço Prelúdio";
  const validUntilTxt = fmtDateTimePtBR(validUntilMs).split(",")[0]; // só a data
  const html = renderShell({
    heading: "Tier Estudante ativo",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Sua declaração de matrícula foi aprovada. O <strong>plano Estudante</strong> está liberado e você pode usar o Espaço Prelúdio sem mensalidade até <strong>${escHtml(validUntilTxt)}</strong>.</p>
      <p style="margin:0 0 16px;">No vencimento, vamos pedir um comprovante atualizado pra renovar — se você ainda estiver no último ano, é instantâneo.</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Acessar painel</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Lembre-se: o tier Estudante exige matrícula ativa no último ano de Psicologia ou Medicina cursando clínica-escola/internato. Profissionais já formados que utilizem este tier de forma indevida terão a conta cancelada e a mensalidade Profissional cobrada retroativamente.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSua declaração de matrícula foi aprovada. O plano Estudante está liberado até ${validUntilTxt}.\n\nAcesse: ${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// E-mail enviado quando admin aprova manualmente o comprovante de inscrição
// CRP/CRM (tier recém-formado).
function templateRecemFormadoApproved({ therapistName, painelUrl }) {
  const subject = "Tier Recém-formado liberado no Espaço Prelúdio";
  const html = renderShell({
    heading: "Tier Recém-formado habilitado",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Sua inscrição no conselho foi confirmada. Você está habilitado para contratar a assinatura do Espaço Prelúdio com o desconto do tier <strong>Recém-formado: R$ 49,90/mês</strong> (em vez de R$ 120/mês do plano Profissional).</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Contratar agora</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">O desconto é válido enquanto sua inscrição estiver dentro dos primeiros 12 meses. Após esse período, a renovação migra automaticamente para o tier Profissional.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSua inscrição no conselho foi confirmada. Você pode contratar a R$ 49,90/mês (tier Recém-formado).\n\nAcesse: ${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateRecemFormadoRejected({ therapistName, reason, retryUrl }) {
  const subject = "Sobre seu comprovante de inscrição no Espaço Prelúdio";
  const html = renderShell({
    heading: "Comprovante não aprovado",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Revisamos seu comprovante de inscrição no conselho e ele não atende aos critérios do tier Recém-formado. Motivo:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-style: italic;">${escHtml(reason)}</p>
      <p style="margin:0 0 16px;">Você pode enviar um novo comprovante (print do e-Psi/portal CFM ou foto da carteira) ou, se sua inscrição é mais antiga que 12 meses, contratar diretamente o plano Profissional (R$ 120/mês).</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(retryUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Enviar outro comprovante</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Em caso de dúvida, responda este e-mail.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSeu comprovante de inscrição não foi aprovado. Motivo: ${reason}\n\nEnviar outro: ${retryUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// E-mail enviado quando admin rejeita manualmente o comprovante de matrícula.
function templateStudentRejected({ therapistName, reason, retryUrl }) {
  const subject = "Sobre seu comprovante de matrícula no Espaço Prelúdio";
  const html = renderShell({
    heading: "Comprovante não aprovado",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Revisamos seu comprovante de matrícula e ele não atende aos critérios do tier Estudante. Motivo apontado pela nossa equipe:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-style: italic;">${escHtml(reason)}</p>
      <p style="margin:0 0 16px;">Você pode enviar um novo comprovante (declaração atualizada, mais legível, ou com a situação de matrícula explícita) pelo link abaixo. Ou, se preferir, partir direto pro plano Profissional.</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(retryUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Enviar outro comprovante</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Sua conta continua ativa em modo trial. Em caso de dúvida, responda este e-mail.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSeu comprovante de matrícula não foi aprovado. Motivo: ${reason}\n\nEnviar novo comprovante: ${retryUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// ─── Helpers de URL ─────────────────────────────────────────────────────

function buildJoinUrl(joinToken) {
  return `${THERAPY_FRONTEND_BASE}/entrar.html?t=${encodeURIComponent(joinToken)}`;
}
function buildCancelUrl(cancelToken) {
  return `${THERAPY_FRONTEND_BASE}/cancelar.html?t=${encodeURIComponent(cancelToken)}`;
}

function buildPainelUrl() {
  return `${THERAPY_FRONTEND_BASE}/painel.html`;
}
function buildPlanosUrl() {
  return `${THERAPY_FRONTEND_BASE}/planos.html`;
}
function buildComprovanteEstudanteUrl() {
  return `${THERAPY_FRONTEND_BASE}/comprovante-estudante.html`;
}
function buildComprovanteRecemFormadoUrl() {
  return `${THERAPY_FRONTEND_BASE}/comprovante-recem-formado.html`;
}

module.exports = {
  sendEmail,
  templateConfirmation,
  templateReminder,
  templateDispensacaoNotice,
  templateStudentApproved,
  templateStudentRejected,
  templateRecemFormadoApproved,
  templateRecemFormadoRejected,
  buildJoinUrl,
  buildCancelUrl,
  buildPainelUrl,
  buildPlanosUrl,
  buildComprovanteEstudanteUrl,
  buildComprovanteRecemFormadoUrl
};
