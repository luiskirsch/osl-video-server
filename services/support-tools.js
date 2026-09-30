"use strict";

// Ferramentas da Aurora (assistente do Espaço Prelúdio). Cada instância é
// criada pela rota já presa ao uid autenticado: nenhuma ferramenta recebe uid
// do modelo, então não há como ler dados de outra conta. Só metadados
// operacionais — prontuário, anotações e resumos são cifrados no cliente e
// ficam fora do alcance do servidor (e, portanto, da Aurora).

const { therapySessionDurationMinutes, therapyTimestampMillis } = require("./therapy-session-state");

const DAY_MS = 24 * 60 * 60 * 1000;
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000; // America/Sao_Paulo, sem horário de verão desde 2019
const MAX_SESSIONS = 40;
const CHANGELOG_TTL_MS = 30 * 60 * 1000;
const CHANGELOG_URL = "https://api.github.com/repos/luiskirsch/espaco-preludio-web/commits?per_page=80";

const TOOL_DEFINITIONS = [
  {
    name: "ver_agenda",
    description: "Lista as sessões do profissional logado num período, contado a partir de hoje (fuso de São Paulo): data e hora, paciente, status e duração. Use para perguntas sobre agenda, horários livres/ocupados, quem ele atende e quantas consultas fez ou fará. Para 'hoje' use dias_futuros 0; 'amanhã' ou 'esta semana' use dias_futuros 1 a 7; para o que já aconteceu use dias_passados.",
    input_schema: {
      type: "object",
      properties: {
        dias_futuros: { type: "integer", description: "Quantos dias à frente incluir além de hoje (0 a 60)." },
        dias_passados: { type: "integer", description: "Quantos dias para trás incluir (0 a 60)." }
      },
      required: ["dias_futuros", "dias_passados"],
      additionalProperties: false
    },
    strict: true
  },
  {
    name: "ver_status_da_conta",
    description: "Situação da conta do profissional logado: plano, se o acesso a consultas está liberado (e por quê não, se for o caso), fim do período de teste, selo de verificação, itens do perfil público que faltam preencher e integrações ativas (2FA, NFS-e, WhatsApp, Asaas, resumo por IA). Use para 'tenho alguma pendência?', 'qual meu plano?', 'por que não consigo criar consulta?'.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true
  },
  {
    name: "ver_novidades",
    description: "Mudanças publicadas recentemente no Espaço Prelúdio, com data (mais recentes primeiro). Use para 'qual foi a última atualização?', 'o que mudou?', 'tem novidade?'. As mensagens são técnicas: traduza para benefícios práticos ao profissional.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true
  }
];

const STATUS_LABELS = {
  scheduled: "agendada",
  confirmed: "confirmada",
  pending: "aguardando confirmação",
  in_progress: "em andamento",
  completed: "concluída",
  canceled: "cancelada",
  cancelled: "cancelada",
  no_show: "falta"
};

const PLAN_LABELS = {
  pro: "Profissional",
  trial: "Teste",
  "student-active": "Estudante",
  empresa: "Programa institucional",
  canceled: "Cancelado",
  expired: "Expirado"
};

const BLOCK_REASONS = {
  TRIAL_EXPIRADO: "período de teste terminou e não há assinatura ativa",
  MEIO_PAGAMENTO_OBRIGATORIO: "falta cadastrar o meio de pagamento para liberar as consultas",
  STUDENT_EXPIRADO: "a validação de estudante expirou",
  PROFISSIONAL_NAO_REGISTRADO: "cadastro profissional incompleto"
};

// Mensagens de commit que não são mudança perceptível pelo profissional, ou
// que detalham correções de segurança (não devem ser anunciadas pela Aurora).
const CHANGELOG_SKIP = [
  /^(test|tests|chore|ci|build|docs|style|refactor|perf|revert|security)(\(.+\))?!?:/i,
  /\b(staging|mirror|espelh|cache[- ]?bust|bump|merge|xss|vulnerab|exploit|pentest|cve-)/i
];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function startOfTodaySaoPaulo(now) {
  return Math.floor((now - SAO_PAULO_OFFSET_MS) / DAY_MS) * DAY_MS + SAO_PAULO_OFFSET_MS;
}

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
});
const DATE_ONLY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });

function formatDateTime(ms) { return DATE_TIME.format(new Date(ms)); }
function formatDate(ms) { return DATE_ONLY.format(new Date(ms)); }

// Nome + inicial do sobrenome: suficiente pro profissional reconhecer, sem
// mandar o nome completo do paciente pra fora.
function shortPatientName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Paciente sem nome";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function createSupportTools({ uid, db, loadTherapist, evaluatePlanAccess, fetchImpl = fetch, now = () => Date.now(), changelogCache = { at: 0, value: null } }) {
  async function verAgenda(input) {
    const futuros = clampInt(input?.dias_futuros, 0, 60, 7);
    const passados = clampInt(input?.dias_passados, 0, 60, 0);
    const current = now();
    const todayStart = startOfTodaySaoPaulo(current);
    const from = todayStart - passados * DAY_MS;
    const to = todayStart + (futuros + 1) * DAY_MS;

    const snap = await db.collection("therapy_sessions").where("therapistUid", "==", uid).limit(500).get();
    const sessions = snap.docs
      .map(doc => doc.data())
      .filter(s => s.syntheticData !== true)
      .map(s => ({ s, at: therapyTimestampMillis(s.scheduledAt) }))
      .filter(({ at }) => at && at >= from && at < to)
      .sort((a, b) => a.at - b.at);

    return {
      agora: formatDateTime(current),
      periodo: `${formatDate(from)} a ${formatDate(to - 1)}`,
      total: sessions.length,
      sessoes: sessions.slice(0, MAX_SESSIONS).map(({ s, at }) => ({
        quando: formatDateTime(at),
        paciente: shortPatientName(s.patientName),
        status: STATUS_LABELS[s.status] || String(s.status || "desconhecido"),
        duracaoMin: therapySessionDurationMinutes(s)
      })),
      truncado: sessions.length > MAX_SESSIONS
    };
  }

  async function verStatusDaConta() {
    const t = await loadTherapist(uid);
    if (!t) return { erro: "Cadastro profissional não encontrado." };
    const access = evaluatePlanAccess(t);
    return {
      plano: PLAN_LABELS[access.plano] || String(access.plano || "não definido"),
      consultasLiberadas: !!access.ok,
      motivoDoBloqueio: access.ok ? null : (BLOCK_REASONS[access.reason] || access.reason || null),
      testeAte: access.trialUntil ? formatDate(access.trialUntil) : null,
      seloVerificado: t.verificationStatus === "verified",
      verificacao: t.verificationStatus || "não solicitada",
      perfilFaltando: [
        !t.photoBase64 && "foto",
        !t.especialidade && "especialidade",
        !t.bio && "apresentação (bio)",
        !t.consultorio?.cidade && "cidade do consultório"
      ].filter(Boolean),
      integracoes: {
        autenticacaoDoisFatores: !!t.twoFactorEnabled,
        notaFiscalAutomatica: !!t.nfseConfig,
        whatsapp: !!t.whatsappConfig && t.whatsappConfig.enabled !== false,
        cobrancaAsaas: !!(t.asaasEnabled || t.asaasApiKey),
        resumoPorIA: !!t.aiSummaryEnabled
      }
    };
  }

  async function verNovidades() {
    if (changelogCache.value && now() - changelogCache.at < CHANGELOG_TTL_MS) return changelogCache.value;
    const res = await fetchImpl(CHANGELOG_URL, {
      headers: { "User-Agent": "EspacoPreludio-Aurora", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`GITHUB_HTTP_${res.status}`);
    const commits = await res.json();
    const itens = (Array.isArray(commits) ? commits : [])
      .map(c => ({ at: Date.parse(c?.commit?.author?.date || ""), msg: String(c?.commit?.message || "").split("\n")[0].trim() }))
      .filter(c => c.msg && Number.isFinite(c.at) && !CHANGELOG_SKIP.some(re => re.test(c.msg)))
      .slice(0, 25)
      .map(c => ({ data: formatDate(c.at), mudanca: c.msg.slice(0, 200) }));
    const value = { itens };
    changelogCache.at = now();
    changelogCache.value = value;
    return value;
  }

  const handlers = { ver_agenda: verAgenda, ver_status_da_conta: verStatusDaConta, ver_novidades: verNovidades };

  return {
    definitions: TOOL_DEFINITIONS,
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) return { isError: true, content: `Ferramenta desconhecida: ${name}` };
      try {
        return { isError: false, content: JSON.stringify(await handler(input || {})) };
      } catch (err) {
        return { isError: true, content: `Não foi possível consultar agora (${err.message}). Diga isso ao usuário sem inventar dados.` };
      }
    }
  };
}

module.exports = { createSupportTools, TOOL_DEFINITIONS, _test: { startOfTodaySaoPaulo, shortPatientName, CHANGELOG_SKIP } };
