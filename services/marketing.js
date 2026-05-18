// Espaço Prelúdio — Marketing automation (Fase 1 MVP).
//
// Audiences (segmentos) PREDEFINIDOS — sem custom builder em Fase 1:
//   - "all"             — todos os pacientes do prof
//   - "active"          — pacientes com consulta nos ultimos 90 dias
//   - "lapsed-3m"       — sem consulta ha 3-6 meses (alvo classico de reativacao)
//   - "lapsed-6m"       — sem consulta ha mais de 6 meses
//   - "birthday-month"  — aniversariantes do mes corrente
//   - "tag"             — pacientes com tag X (parametrizado)
//
// Campanhas: one-shot por enquanto. Sequencias drip (D+0, D+3, D+7) — Fase 2.
//
// Compliance: paciente cifrado E2EE no Firestore. Pra resolver "lapsed-3m"
// o backend conhece scheduledAt das sessoes (plaintext) e pode filtrar por
// patientId, depois o frontend decifra nome/email e dispara envio. Backend
// nao manda email — frontend faz, com DEK.
//
// Trade-off: cron-style campanhas (envio agendado) nao funciona em Fase 1
// porque exige DEK do user. Campanhas sao MANUAIS — user abre /marketing.html,
// escolhe audience + template, clica "Enviar".

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const AUDIENCES = {
  all: {
    label: "Todos os pacientes",
    description: "Todos os pacientes ativos no seu cadastro."
  },
  active: {
    label: "Pacientes ativos (90d)",
    description: "Tiveram consulta nos últimos 90 dias."
  },
  "lapsed-3m": {
    label: "Sem consulta há 3-6 meses",
    description: "Alvo clássico de reativação."
  },
  "lapsed-6m": {
    label: "Sem consulta há +6 meses",
    description: "Reativação agressiva — quase ex-pacientes."
  },
  "birthday-month": {
    label: "Aniversariantes do mês",
    description: "Pacientes com aniversário no mês corrente."
  }
};

const TEMPLATES = {
  "reativacao-suave": {
    label: "Reativação suave",
    subject: "Faz tempo, como você está?",
    bodyHint: "Bom pra lapsed-3m. Tom: cuidadoso, sem urgência.",
    bodyMd: `Olá [NOME_PACIENTE],

Faz um tempo desde nossa última conversa. Só queria te dizer que estou aqui, caso queira retomar.

Sem pressão — só um aviso de que a porta continua aberta.

Um abraço,
[NOME_PROFISSIONAL]`
  },
  "reativacao-firme": {
    label: "Reativação firme",
    subject: "Vamos retomar?",
    bodyHint: "Bom pra lapsed-6m. Tom: convidativo, direto.",
    bodyMd: `Olá [NOME_PACIENTE],

Faz mais de 6 meses desde nossa última sessão. Quero te perguntar: faz sentido a gente retomar?

Tenho horários abertos esta semana. Se quiser, basta responder este e-mail com um dia/horário e marco.

[NOME_PROFISSIONAL]`
  },
  "aniversario": {
    label: "Aniversário",
    subject: "Feliz aniversário, [NOME_PACIENTE]!",
    bodyHint: "Pra audience birthday-month. Curto e afetuoso.",
    bodyMd: `Olá [NOME_PACIENTE],

Que neste novo ciclo você tenha saúde, leveza e tempo pra cuidar do que importa pra você.

Um abraço,
[NOME_PROFISSIONAL]`
  },
  "novidade": {
    label: "Comunicar novidade",
    subject: "[Espaço Prelúdio] Novidade no consultório",
    bodyHint: "Pra audience all. Use pra anunciar férias, novo horário, etc.",
    bodyMd: `Olá [NOME_PACIENTE],

[ESCREVA SUA MENSAGEM AQUI]

[NOME_PROFISSIONAL]`
  }
};

// Filtra patientIds elegíveis pra cada audience. Retorna SET de patientIds.
// Args:
//   audienceKey: "all" | "active" | "lapsed-3m" | "lapsed-6m" | "birthday-month"
//   audienceParams: opcionais por audience (ex: tag pra audience "tag")
//   sessionsByPatientId: Map<patientId, lastSessionMs> (extraido das therapy_sessions)
//   patients: array dos pacientes (com birthdate decifrado, name, etc.)
function resolveAudiencePatients(audienceKey, audienceParams, sessionsByPatientId, patients) {
  const now = Date.now();
  const THREE_M = 90 * ONE_DAY_MS;
  const SIX_M = 180 * ONE_DAY_MS;
  const eligible = new Set();

  for (const p of patients || []) {
    const lastSession = sessionsByPatientId.get(p.patientId) || 0;
    const sinceLast = lastSession ? (now - lastSession) : Infinity;

    if (audienceKey === "all") {
      eligible.add(p.patientId);
    } else if (audienceKey === "active") {
      if (sinceLast <= THREE_M) eligible.add(p.patientId);
    } else if (audienceKey === "lapsed-3m") {
      if (sinceLast > THREE_M && sinceLast <= SIX_M) eligible.add(p.patientId);
    } else if (audienceKey === "lapsed-6m") {
      if (sinceLast > SIX_M && sinceLast !== Infinity) eligible.add(p.patientId);
    } else if (audienceKey === "birthday-month") {
      if (!p.birthdate) continue;
      // birthdate formato YYYY-MM-DD
      const m = String(p.birthdate).match(/^\d{4}-(\d{2})-/);
      if (m && Number(m[1]) === (new Date().getMonth() + 1)) eligible.add(p.patientId);
    }
  }
  return eligible;
}

// Substitui placeholders [NOME_PACIENTE] e [NOME_PROFISSIONAL] no texto.
function renderTemplate(text, { patientName, therapistName }) {
  return String(text || "")
    .replace(/\[NOME_PACIENTE\]/gi, patientName || "")
    .replace(/\[NOME_PROFISSIONAL\]/gi, therapistName || "");
}

// Converte markdown leve pra HTML basico (so quebras de linha + paragrafos).
function mdToHtml(md) {
  const escaped = String(md || "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  return escaped
    .split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 14px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

module.exports = {
  AUDIENCES,
  TEMPLATES,
  resolveAudiencePatients,
  renderTemplate,
  mdToHtml
};
