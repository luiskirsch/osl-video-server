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

// Convite pra paciente responder escala clínica (PHQ-9 ou GAD-7).
// Tom: leve, sem alarmismo. Foca no acompanhamento, não no diagnóstico.
function templateEscalaEnviada({ patientName, therapistName, scaleName, escalaUrl }) {
  const subject = `${therapistName} pediu para você responder: ${scaleName}`;
  const html = renderShell({
    heading: "Acompanhamento do seu bem-estar",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName || "")},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(therapistName)}</strong> preparou um questionário curto pra acompanhar como você tem se sentido: <strong>${escHtml(scaleName)}</strong>.</p>
      <p style="margin:0 0 16px; padding:12px 14px; background:#f7f4ef; border-radius:6px;">
        ⏱ <strong>Leva menos de 3 minutos.</strong> Responda no seu ritmo. Suas respostas vão direto pro profissional.
      </p>
      <p style="margin:0 0 24px;"><a href="${escHtml(escalaUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Responder agora</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">O link é único pra você e fica disponível por 30 dias.</p>
    `,
    footer: "Você recebeu este e-mail porque seu profissional pediu uma escala de acompanhamento pelo Espaço Prelúdio."
  });
  const text = `Olá ${patientName || ""},\n\n${therapistName} preparou um questionário (${scaleName}) pra acompanhar seu bem-estar. Leva menos de 3 minutos.\n\nLink: ${escalaUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateEscalaRespondida({ therapistName, patientName, scaleName, score, bandLabel, suicideAlert, painelUrl }) {
  const subject = suicideAlert
    ? `⚠ ALERTA: ${patientName || "paciente"} sinalizou risco na ${scaleName}`
    : `${scaleName} de ${patientName || "paciente"} foi respondida (score ${score})`;
  const html = renderShell({
    heading: suicideAlert ? "Alerta clínico" : "Escala respondida",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      ${suicideAlert ? `<p style="margin:0 0 16px; padding:14px 16px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; color:#7f1d1d;"><strong>⚠ Sinalização de risco:</strong> ${escHtml(patientName || "o paciente")} marcou pontuação maior que zero na pergunta sobre pensamentos de morte/autolesão. Recomenda-se avaliar diretamente na próxima oportunidade.</p>` : ""}
      <p style="margin:0 0 16px;"><strong>${escHtml(patientName || "Paciente")}</strong> acabou de responder a escala <strong>${escHtml(scaleName)}</strong>.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Score</td><td style="padding:3px 0; text-align:right;"><strong style="font-size:18px;">${score}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Faixa</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(bandLabel || "—")}</strong></td></tr>
      </table>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Ver no painel</a></p>
    `,
    footer: "Notificação automática do Espaço Prelúdio."
  });
  const text = `${suicideAlert ? "ALERTA: " : ""}${patientName || "Paciente"} respondeu ${scaleName}.\n\nScore: ${score}\nFaixa: ${bandLabel || "—"}\n${suicideAlert ? "\nSINALIZAÇÃO DE RISCO na pergunta sobre pensamentos de morte/autolesão. Avalie diretamente.\n" : ""}\nVer no painel: ${painelUrl}`;
  return { subject, html, text };
}

// Convite pra paciente preencher anamnese pré-consulta. Foco: tom cuidadoso
// (vamos pedir histórico clínico, queixa principal — coisas íntimas), aviso
// claro sobre tempo (~10min) e LGPD.
function templateAnamneseEnviada({ patientName, therapistName, anamneseUrl }) {
  const subject = `${therapistName} pediu para você preencher uma anamnese`;
  const html = renderShell({
    heading: "Antes da primeira sessão",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName || "")},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(therapistName)}</strong> quer entender melhor seu contexto antes da primeira sessão. Pra isso preparou uma anamnese — algumas perguntas sobre você, seu momento atual e o motivo da busca por terapia.</p>
      <p style="margin:0 0 16px; padding:12px 14px; background:#f7f4ef; border-radius:6px;">
        ⏱ <strong>Leva uns 10 minutos.</strong> Você pode responder com calma, no seu tempo, e suas respostas vão direto pro profissional — só ele vê.
      </p>
      <p style="margin:0 0 24px;"><a href="${escHtml(anamneseUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Começar anamnese</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Suas respostas são tratadas conforme a LGPD. O link é único pra você e fica disponível por 30 dias.</p>
    `,
    footer: "Você recebeu este e-mail porque um profissional do Espaço Prelúdio pediu uma anamnese pra você."
  });
  const text = `Olá ${patientName || ""},\n\n${therapistName} pediu pra você preencher uma anamnese antes da primeira sessão. Leva uns 10 minutos.\n\nLink: ${anamneseUrl}\n\nSuas respostas vão direto pro profissional. O link é único e válido por 30 dias.\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Notifica o terapeuta quando o paciente termina a anamnese.
function templateAnamneseRespondida({ therapistName, patientName, painelUrl }) {
  const subject = `Anamnese de ${patientName || "paciente"} foi preenchida`;
  const html = renderShell({
    heading: "Anamnese preenchida",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(patientName || "Seu paciente")}</strong> acabou de preencher a anamnese. Você já pode revisar as respostas no painel.</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Abrir painel</a></p>
    `,
    footer: "Notificação automática do Espaço Prelúdio."
  });
  const text = `Olá ${therapistName},\n\n${patientName || "Seu paciente"} acabou de preencher a anamnese. Veja no painel:\n${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Recibo enviado pro paciente após o pagamento. Link público pra visualizar
// (com download PDF). Texto formato carta curta + valor destacado.
function templateReciboEnviado({ patientName, therapistName, amountCents, paymentMethodLabel, paidDateMs, reciboUrl, sequentialNumber }) {
  const subject = `Recibo de ${therapistName} ${sequentialNumber ? `(nº ${sequentialNumber})` : ""}`.trim();
  // Coercao defensiva — amountCents pode chegar null/undefined em recibos
  // manuais sem valor, antes dava "R$ NaN" no email.
  const cents = Number(amountCents) || 0;
  const valor = "R$ " + (cents / 100).toFixed(2).replace(".", ",");
  const dataFmt = paidDateMs
    ? new Date(paidDateMs).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" })
    : "";
  const html = renderShell({
    heading: "Seu recibo",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName)},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(therapistName)}</strong> emitiu um recibo pra você:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Valor</td><td style="padding:3px 0; text-align:right;"><strong style="font-size:18px;">${escHtml(valor)}</strong></td></tr>
        ${dataFmt ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Pagamento em</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(dataFmt)}</strong></td></tr>` : ""}
        ${paymentMethodLabel ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Forma</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(paymentMethodLabel)}</strong></td></tr>` : ""}
        ${sequentialNumber ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Nº do recibo</td><td style="padding:3px 0; text-align:right;"><strong>${sequentialNumber}</strong></td></tr>` : ""}
      </table>
      <p style="margin:0 0 24px;"><a href="${escHtml(reciboUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Ver e baixar recibo</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Você pode baixar o PDF na página acima. Guarde-o pro IR, reembolso de plano de saúde ou referência futura.</p>
    `,
    footer: "Recibo emitido eletronicamente pelo Espaço Prelúdio."
  });
  const text = `Olá ${patientName},\n\n${therapistName} emitiu um recibo pra você:\n\nValor: ${valor}${dataFmt ? `\nPagamento em: ${dataFmt}` : ""}${paymentMethodLabel ? `\nForma: ${paymentMethodLabel}` : ""}${sequentialNumber ? `\nNº do recibo: ${sequentialNumber}` : ""}\n\nVer e baixar PDF: ${reciboUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Notifica o terapeuta de uma solicitação pública de agendamento. CTA leva
// pro painel (onde aprova/rejeita). reply_to do paciente fica como pista
// alternativa caso queira responder direto antes de aprovar.
function templateSchedulingRequest({ therapistName, patientName, patientEmail, patientPhone, notes, requestedSlot, painelUrl }) {
  const subject = `Novo pedido de consulta de ${patientName}`;
  const when = fmtDateTimePtBR(requestedSlot);
  const html = renderShell({
    heading: "Pedido de agendamento",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(patientName)}</strong> solicitou um horário com você pelo seu link público.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Horário pedido</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(when)}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">E-mail</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(patientEmail)}</strong></td></tr>
        ${patientPhone ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Telefone</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(patientPhone)}</strong></td></tr>` : ""}
      </table>
      ${notes ? `<p style="margin:0 0 8px; font-size:13px; color:rgba(28,31,29,0.65);">Observações do paciente:</p><blockquote style="margin:0 0 20px; padding:10px 14px; background:#f7f4ef; border-left:3px solid #c89b4a; border-radius:4px; font-size:14px; color:rgba(28,31,29,0.85);">${escHtml(notes)}</blockquote>` : ""}
      <p style="margin:0 0 8px;">Entre no painel pra aprovar ou recusar:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Abrir painel</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">O paciente recebe a confirmação por e-mail assim que você aprovar.</p>
    `,
    footer: "Você recebeu este e-mail porque ativou o agendamento público no Espaço Prelúdio."
  });
  const text = `Olá ${therapistName},\n\n${patientName} solicitou um horário com você pelo seu link público.\n\nHorário: ${when}\nE-mail: ${patientEmail}${patientPhone ? `\nTelefone: ${patientPhone}` : ""}${notes ? `\n\nObservações: ${notes}` : ""}\n\nAprove ou recuse no painel: ${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateConfirmation({ patientName, therapistName, scheduledAt, joinUrl, cancelUrl, minCancelHours }) {
  const subject = `Sua consulta com ${therapistName} foi agendada`;
  const when = fmtDateTimePtBR(scheduledAt);
  // Default 24h se nao passado (compat com chamadores antigos). Backend
  // que chama deve passar THERAPY_MIN_CANCEL_HOURS_PATIENT do config.
  const hours = Number.isFinite(Number(minCancelHours)) && Number(minCancelHours) > 0
    ? Math.round(Number(minCancelHours))
    : 24;
  const hoursLabel = hours === 24 ? "24h" : `${hours}h`;
  const html = renderShell({
    heading: "Consulta agendada",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName)},</p>
      <p style="margin:0 0 16px;">Sua consulta com <strong>${escHtml(therapistName)}</strong> foi marcada para:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-weight:500;">${escHtml(when)}</p>
      <p style="margin:0 0 20px;">No horário, entre na sessão por este link:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(joinUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Entrar na consulta</a></p>
      ${cancelUrl ? `<p style="margin:0 0 8px; font-size:13px; color:rgba(28,31,29,0.65);">Precisa cancelar? <a href="${escHtml(cancelUrl)}" style="color:rgba(28,31,29,0.65);">Use este link</a> com pelo menos ${escHtml(hoursLabel)} de antecedência.</p>` : ""}
    `,
    footer: "Você recebeu este e-mail porque foi marcada uma consulta para você no Espaço Prelúdio. Se isso não foi você, ignore."
  });
  const text = `Olá ${patientName},\n\nSua consulta com ${therapistName} foi marcada para ${when}.\n\nLink para entrar: ${joinUrl}\n${cancelUrl ? `Cancelar: ${cancelUrl} (com ${hoursLabel} de antecedência)\n` : ""}\nEspaço Prelúdio`;
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

function templateReminder({ patientName, therapistName, scheduledAt, joinUrl, cancelUrl, confirmUrl }) {
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
  // CTA hierarchy:
  //   - Em "agora"/"em breve": prioriza Entrar.
  //   - Em "hoje"/"amanhã": mostra Entrar + Confirmar presença lado a lado.
  const isImmediate = relativeWhen === "agora" || relativeWhen === "em breve";
  const html = renderShell({
    heading,
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(patientName)},</p>
      <p style="margin:0 0 16px;">Lembrete: você tem consulta com <strong>${escHtml(therapistName)}</strong> em:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-weight:500;">${escHtml(when)}</p>
      <p style="margin:0 0 16px;"><a href="${escHtml(joinUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Entrar na consulta</a></p>
      ${(confirmUrl && !isImmediate) ? `<p style="margin:0 0 24px;"><a href="${escHtml(confirmUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:500; font-size:14px;">Confirmar presença</a> <span style="font-size:13px; color:rgba(28,31,29,0.55); margin-left:8px;">Avisa o profissional que você vem.</span></p>` : ""}
      ${cancelUrl ? `<p style="margin:0 0 0; font-size:13px; color:rgba(28,31,29,0.65);">Não vai conseguir? Use este <a href="${escHtml(cancelUrl)}" style="color:rgba(28,31,29,0.65);">link de cancelamento</a> ou avise diretamente o profissional.</p>` : ""}
    `,
    footer: "Lembrete enviado automaticamente pelo Espaço Prelúdio."
  });
  const text = `Lembrete: você tem consulta com ${therapistName} em ${when}.\n\nLink para entrar: ${joinUrl}\n${confirmUrl && !isImmediate ? `Confirmar presença: ${confirmUrl}\n` : ""}${cancelUrl ? `Cancelar: ${cancelUrl}\n` : ""}\nEspaço Prelúdio`;
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
// no conselho (tier recém-formado). Aceita qualquer um dos 8 conselhos
// suportados — copy genérica.
function templateRecemFormadoApproved({ therapistName, painelUrl }) {
  const subject = "Tier Recém-formado liberado no Espaço Prelúdio";
  const html = renderShell({
    heading: "Tier Recém-formado habilitado",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Sua inscrição no conselho foi confirmada. Você está habilitado para contratar a assinatura do Espaço Prelúdio com o desconto do tier <strong>Recém-formado: R$ 99,50/mês</strong> (em vez de R$ 199/mês do plano Profissional).</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Contratar agora</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">O desconto é válido enquanto sua inscrição estiver dentro dos primeiros 12 meses. Após esse período, a renovação migra automaticamente para o tier Profissional.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSua inscrição no conselho foi confirmada. Você pode contratar a R$ 99,50/mês (tier Recém-formado).\n\nAcesse: ${painelUrl}\n\nEspaço Prelúdio`;
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
      <p style="margin:0 0 16px;">Você pode enviar um novo comprovante (foto da carteira do conselho, print do sistema oficial de busca pública ou declaração de inscrição) ou, se sua inscrição é mais antiga que 12 meses, contratar diretamente o plano Profissional (R$ 199/mês).</p>
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

// Notifica admin sobre novo interessado no tier Estudante (modal da landing
// page pública). reply_to = e-mail do interessado, pra responder direto.
function templateStudentLeadReceived({ name, email, phone, institution, course, message }) {
  const subject = `Novo interesse no plano Estudante: ${name}`;
  const html = renderShell({
    heading: "Novo interessado — Plano Estudante",
    bodyHtml: `
      <p style="margin:0 0 16px;">Alguém preencheu o formulário de interesse do plano Estudante na landing page.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Nome</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(name)}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">E-mail</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(email)}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Telefone</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(phone)}</strong></td></tr>
        ${institution ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Instituição</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(institution)}</strong></td></tr>` : ""}
        ${course ? `<tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Curso</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(course)}</strong></td></tr>` : ""}
      </table>
      ${message ? `<p style="margin:0 0 8px; font-size:13px; color:rgba(28,31,29,0.65);">Mensagem:</p><blockquote style="margin:0; padding:10px 14px; background:#f7f4ef; border-left:3px solid #c89b4a; border-radius:4px; font-size:14px; color:rgba(28,31,29,0.85);">${escHtml(message)}</blockquote>` : ""}
    `,
    footer: "Notificação automática do Espaço Prelúdio."
  });
  const text = `Novo interessado no plano Estudante:\n\nNome: ${name}\nE-mail: ${email}\nTelefone: ${phone}${institution ? `\nInstituição: ${institution}` : ""}${course ? `\nCurso: ${course}` : ""}${message ? `\n\nMensagem: ${message}` : ""}`;
  return { subject, html, text };
}

// ─── Helpers de URL ─────────────────────────────────────────────────────

// Aceita short code (~8 chars) OU joinToken legado (JWT ~500 chars).
// Heurística: códigos curtos ficam <= 16 chars; JWTs sempre passam disso.
function buildJoinUrl(codeOrToken) {
  const s = String(codeOrToken || "");
  const paramName = s.length <= 16 ? "c" : "t";
  return `${THERAPY_FRONTEND_BASE}/entrar.html?${paramName}=${encodeURIComponent(s)}`;
}
function buildCancelUrl(codeOrToken) {
  const param = String(codeOrToken).length <= 16 ? "c" : "t";
  return `${THERAPY_FRONTEND_BASE}/cancelar.html?${param}=${encodeURIComponent(codeOrToken)}`;
}
function buildConfirmUrl(codeOrToken) {
  const param = String(codeOrToken).length <= 16 ? "c" : "t";
  return `${THERAPY_FRONTEND_BASE}/confirmar.html?${param}=${encodeURIComponent(codeOrToken)}`;
}
function buildReciboPublicoUrl(codeOrToken) {
  const param = String(codeOrToken).length <= 16 ? "c" : "t";
  return `${THERAPY_FRONTEND_BASE}/recibo-publico.html?${param}=${encodeURIComponent(codeOrToken)}`;
}
function buildAnamneseUrl(anamneseToken) {
  return `${THERAPY_FRONTEND_BASE}/anamnese.html?t=${encodeURIComponent(anamneseToken)}`;
}
function buildEscalaUrl(escalaToken) {
  return `${THERAPY_FRONTEND_BASE}/escala.html?t=${encodeURIComponent(escalaToken)}`;
}
function buildNpsUrl(codeOrToken) {
  const param = String(codeOrToken).length <= 16 ? "c" : "t";
  return `${THERAPY_FRONTEND_BASE}/nps.html?${param}=${encodeURIComponent(codeOrToken)}`;
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
function buildComprovanteFormacaoUrl() {
  return `${THERAPY_FRONTEND_BASE}/comprovante-formacao.html`;
}

// E-mail enviado quando admin aprova o diploma de formação de profissional
// SEM_CONSELHO. Diferente do recém-formado: aqui não há "tier" — é só
// liberação do perfil público com badge "não regulamentado".
function templateFormacaoApproved({ therapistName, painelUrl }) {
  const subject = "Perfil verificado no Espaço Prelúdio";
  const html = renderShell({
    heading: "Perfil aprovado pela equipe",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Seu diploma de formação foi revisado e aprovado. Seu perfil público no Espaço Prelúdio agora aparece com o selo <strong>"Verificado pela equipe"</strong>, com a indicação <em>"Profissional não regulamentado por conselho oficial"</em>.</p>
      <p style="margin:0 0 16px;">Tudo o que você já podia fazer (consulta, chat, vídeo, anotações cifradas) continua funcionando. O que <strong>não</strong> fica disponível: emissão de receitas e documentos clínicos (atestado de doença, encaminhamento, relatório) — essas funções exigem CRM ou CRP.</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Acessar painel</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Em caso de dúvida, responda este e-mail.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu perfil."
  });
  const text = `Olá ${therapistName},\n\nSeu diploma foi aprovado. Perfil público liberado com selo 'Verificado'.\n\nAcesse: ${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateFormacaoRejected({ therapistName, reason, retryUrl }) {
  const subject = "Sobre seu diploma de formação no Espaço Prelúdio";
  const html = renderShell({
    heading: "Diploma não aprovado",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Revisamos seu diploma de formação e ele não atende aos critérios para liberação do perfil público. Motivo:</p>
      <p style="margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-style: italic;">${escHtml(reason)}</p>
      <p style="margin:0 0 16px;">Você pode enviar um novo documento (diploma mais legível, certificado da instituição, ou declaração assinada pela coordenação do curso) pelo link abaixo. Sua conta continua funcionando normalmente para atendimento; só o perfil público fica oculto até a aprovação.</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(retryUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Enviar outro comprovante</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Em caso de dúvida, responda este e-mail.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu perfil."
  });
  const text = `Olá ${therapistName},\n\nSeu diploma de formação não foi aprovado. Motivo: ${reason}\n\nEnviar outro: ${retryUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Template NPS — disparado 24h após o término de uma sessão completada.
// Tom respeitoso, não-invasivo. Link único expira em 30 dias.
function templateNps({ patientName, therapistName, npsUrl }) {
  const firstName = String(patientName || "").split(/\s+/)[0] || "Paciente";
  const subject = `Como foi sua consulta com ${therapistName}?`;
  const html = renderShell({
    heading: "Sua opinião conta",
    bodyHtml: `
      <p style="margin:0 0 14px;">Olá ${escHtml(firstName)},</p>
      <p style="margin:0 0 14px;">Ontem você teve uma consulta com <strong>${escHtml(therapistName)}</strong>. Gostaríamos de saber como foi.</p>
      <p style="margin:0 0 20px;">Leva menos de 30 segundos:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(npsUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Avaliar a consulta</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.55);">Seu feedback ajuda ${escHtml(therapistName)} a oferecer um cuidado cada vez melhor. Você pode escrever um comentário também, se quiser.</p>
    `,
    footer: "Você recebeu este e-mail porque teve uma consulta agendada no Espaço Prelúdio. Se preferir não receber mais avaliações, basta ignorar."
  });
  const text = `Olá ${firstName},\n\nOntem você teve uma consulta com ${therapistName}. Gostaríamos de saber como foi.\n\nLeva menos de 30 segundos:\n${npsUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Template de aniversário — disparado pelo cron diário às 9h BRT pra pacientes
// com opt-in cadastrado. Tom carinhoso, sem CTA agressivo (não é marketing).
// `therapistName` aparece no subject e na assinatura — o paciente percebe como
// envio "do profissional", não "da plataforma".
function templateBirthday({ patientName, therapistName, clinicName }) {
  const firstName = String(patientName || "").split(/\s+/)[0] || "Paciente";
  const fromWhom = clinicName || therapistName || "Espaço Prelúdio";
  const subject = `Feliz aniversário, ${firstName}!`;
  const html = renderShell({
    heading: `Feliz aniversário, ${firstName}! 🎉`,
    bodyHtml: `
      <p style="margin:0 0 14px;">Hoje é o seu dia.</p>
      <p style="margin:0 0 14px;">Que este novo ciclo traga saúde, leveza e tempo pra você cuidar do que importa.</p>
      <p style="margin:0 0 20px;">Um abraço,<br><strong>${escHtml(therapistName || fromWhom)}</strong>${clinicName && clinicName !== therapistName ? `<br><span style="color:rgba(28,31,29,0.55); font-size:13px;">${escHtml(clinicName)}</span>` : ""}</p>
    `,
    footer: "Você recebeu este e-mail porque seu profissional ativou um lembrete de aniversário pra você no Espaço Prelúdio. Se preferir não receber, fale com seu profissional."
  });
  const text = `Feliz aniversário, ${firstName}!\n\nHoje é o seu dia. Que este novo ciclo traga saúde, leveza e tempo pra você cuidar do que importa.\n\nUm abraço,\n${therapistName || fromWhom}${clinicName && clinicName !== therapistName ? `\n${clinicName}` : ""}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// E-mail disparado pelo cron quando studentVerifiedUntil <= now. Tier estudante
// expira anualmente; profissional precisa enviar comprovante atualizado pra
// renovar ou migrar pra plano normal.
function templateStudentExpired({ therapistName, retryUrl, planosUrl }) {
  const subject = "Seu tier Estudante expirou — envie novo comprovante";
  const html = renderShell({
    heading: "Tier Estudante expirou",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Seu tier Estudante (gratuito) tinha validade de 1 ano e expirou. Sua conta foi movida pra modo trial — você tem <strong>7 dias</strong> pra decidir:</p>
      <ul style="margin:0 0 20px; padding-left:22px; line-height:1.7;">
        <li><strong>Continuar como estudante:</strong> envie um comprovante de matrícula atualizado (declaração ou atestado de matrícula vigente).</li>
        <li><strong>Migrar pra Recém-formado (R$ 99,50/mês):</strong> se já se formou e tem inscrição no conselho com menos de 12 meses.</li>
        <li><strong>Migrar pra Profissional (R$ 199/mês):</strong> se já é profissional inscrito.</li>
      </ul>
      <p style="margin:0 0 12px;"><a href="${escHtml(retryUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Enviar novo comprovante</a></p>
      <p style="margin:0 0 24px;"><a href="${escHtml(planosUrl)}" style="color:#2d8a52; text-decoration:underline;">Ou ver planos pagos →</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Após o trial de 7 dias, sua conta fica em modo limitado (não cria novas consultas) até regularização.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSeu tier Estudante expirou (1 ano). Conta em trial por 7 dias. Envie novo comprovante: ${retryUrl}\nOu veja planos: ${planosUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// E-mail enviado 30 dias antes do tier Recém-formado completar 12 meses.
// Avisa o profissional que o desconto vai terminar e ele vai pagar R$ 199/mês
// se não cancelar/migrar antes.
function templateRecemFormadoEndingSoon({ therapistName, endingDateIso, planosUrl }) {
  const endingDate = new Date(endingDateIso).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  const subject = "Seu desconto Recém-formado termina em 30 dias";
  const html = renderShell({
    heading: "Desconto Recém-formado terminando",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;">Seu tier <strong>Recém-formado</strong> (R$ 99,50/mês) completa 12 meses em <strong>${escHtml(endingDate)}</strong>. Depois dessa data, sua assinatura migra automaticamente pro plano <strong>Profissional</strong> (R$ 199/mês) — o desconto era válido pelo primeiro ano de inscrição no conselho.</p>
      <p style="margin:0 0 16px;">Você não precisa fazer nada — a cobrança continua no mesmo cartão, só o valor muda na próxima fatura após ${escHtml(endingDate)}.</p>
      <p style="margin:0 0 16px;"><strong>Se quiser cancelar antes</strong> da virada, gerencia em:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(planosUrl)}" style="display:inline-block; background:#2d8a52; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Gerenciar plano</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">Aviso enviado uma vez por conta. Próximo aviso só na cobrança no valor novo.</p>
    `,
    footer: "Notificação do Espaço Prelúdio sobre seu plano."
  });
  const text = `Olá ${therapistName},\n\nSeu desconto Recém-formado (R$ 99,50/mês) termina em ${endingDate}. Após essa data, migra automaticamente pra Profissional (R$ 199/mês).\n\nGerenciar plano: ${planosUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

// Convite pra membro de clinica multidisciplinar. invitedEmail recebe email
// com link pra criar conta (ou logar existente) + aceitar.
function templateClinicInvite({ ownerName, clinicName, invitedEmail, repasseRule, acceptUrl }) {
  const subject = `${ownerName} te convidou pra clínica "${clinicName}" no Espaço Prelúdio`;
  let repasseDesc = "";
  if (repasseRule?.type === "percentual") {
    repasseDesc = `Você recebe <strong>${repasseRule.value}%</strong> sobre receita das suas consultas.`;
  } else if (repasseRule?.type === "valor-fixo") {
    const reais = (Number(repasseRule.value) / 100).toFixed(2).replace(".", ",");
    repasseDesc = `Você recebe <strong>R$ ${reais}</strong> fixo por consulta atendida.`;
  }
  const html = renderShell({
    heading: `Você foi convidado(a) pra uma clínica`,
    bodyHtml: `
      <p style="margin:0 0 14px;">Olá,</p>
      <p style="margin:0 0 14px;"><strong>${escHtml(ownerName)}</strong> te convidou pra ser membro da clínica <strong>${escHtml(clinicName)}</strong> no Espaço Prelúdio.</p>
      <p style="margin:0 0 14px;">${repasseDesc}</p>
      <p style="margin:24px 0;"><a href="${escHtml(acceptUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Ver convite e aceitar</a></p>
      <p style="margin:0 0 14px; font-size:13px; color:rgba(28,31,29,0.65);">
        Como funciona: você atende seus próprios pacientes normalmente. Quando emite recibo de uma consulta como membro da clínica, o sistema calcula o repasse automaticamente.
        Cada profissional mantém sua conta individual no Espaço Prelúdio (R$ 199/mês).
      </p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">
        Se você ainda não tem conta no Espaço Prelúdio, clique no botão acima e siga o cadastro com o email <strong>${escHtml(invitedEmail)}</strong> — o convite vincula automaticamente.
      </p>
    `,
    footer: `Você recebeu este e-mail porque ${escHtml(ownerName)} te convidou pra clínica no Espaço Prelúdio. Se não foi você, ignore.`
  });
  const text = `${ownerName} te convidou pra clínica "${clinicName}" no Espaço Prelúdio.\n\n${repasseDesc.replace(/<[^>]+>/g, "")}\n\nVer convite e aceitar: ${acceptUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

function templateStudentSessionRequest({ studentName, studentEmail, programName, schoolName, therapistName, painelUrl }) {
  const subject = `Aluno solicita nova consulta — ${studentName}`;
  const html = renderShell({
    heading: "Solicitação de consulta",
    bodyHtml: `
      <p style="margin:0 0 12px;">Olá ${escHtml(therapistName)},</p>
      <p style="margin:0 0 16px;"><strong>${escHtml(studentName)}</strong> solicitou um novo horário de consulta pelo portal do aluno.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; padding:14px 16px; background:#f7f4ef; border-radius:6px; font-size:14px;">
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Programa</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(programName || "—")}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">Escola</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(schoolName || "—")}</strong></td></tr>
        <tr><td style="padding:3px 0; color:rgba(28,31,29,0.55);">E-mail de contato</td><td style="padding:3px 0; text-align:right;"><strong>${escHtml(studentEmail)}</strong></td></tr>
      </table>
      <p style="margin:0 0 8px;">Acesse o painel para agendar a consulta:</p>
      <p style="margin:0 0 24px;"><a href="${escHtml(painelUrl)}" style="display:inline-block; background:#2d4a3e; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:500;">Abrir painel</a></p>
      <p style="margin:0; font-size:13px; color:rgba(28,31,29,0.65);">O aluno receberá o link de acesso à sessão por e-mail assim que você agendar.</p>
    `,
    footer: "Você recebeu este e-mail porque um aluno do programa escolar solicitou uma consulta no Espaço Prelúdio."
  });
  const text = `Olá ${therapistName},\n\n${studentName} solicitou um novo horário de consulta pelo portal do aluno.\n\nPrograma: ${programName || "—"}\nEscola: ${schoolName || "—"}\nE-mail: ${studentEmail}\n\nAgendar no painel: ${painelUrl}\n\nEspaço Prelúdio`;
  return { subject, html, text };
}

module.exports = {
  sendEmail,
  templateConfirmation,
  templateSchedulingRequest,
  templateReciboEnviado,
  templateAnamneseEnviada,
  templateAnamneseRespondida,
  templateEscalaEnviada,
  templateEscalaRespondida,
  templateReminder,
  templateBirthday,
  templateNps,
  templateDispensacaoNotice,
  templateStudentApproved,
  templateStudentRejected,
  templateRecemFormadoApproved,
  templateRecemFormadoRejected,
  templateFormacaoApproved,
  templateFormacaoRejected,
  templateStudentExpired,
  templateRecemFormadoEndingSoon,
  templateClinicInvite,
  templateStudentSessionRequest,
  templateStudentLeadReceived,
  buildJoinUrl,
  buildCancelUrl,
  buildConfirmUrl,
  buildReciboPublicoUrl,
  buildAnamneseUrl,
  buildEscalaUrl,
  buildNpsUrl,
  buildPainelUrl,
  buildPlanosUrl,
  buildComprovanteEstudanteUrl,
  buildComprovanteRecemFormadoUrl,
  buildComprovanteFormacaoUrl
};
