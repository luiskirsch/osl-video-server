// Espaço Prelúdio — "Gêmeo Clínico": responde perguntas livres do
// profissional sobre o histórico de UM paciente, usando os resumos de
// sessão (summary + signals) já gerados pelo pipeline de IA como contexto.
//
// Modelo: Claude Haiku 4.5 (mesmo do resumo de sessão)
// - Contexto vai como bloco "system" com cache_control ephemeral: perguntas
//   seguidas sobre o mesmo paciente reaproveitam o cache (~5min) e saem
//   bem mais baratas.

const Anthropic = require("@anthropic-ai/sdk");

let _client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

const SYSTEM_PROMPT = `Você é o "Gêmeo Clínico" — um assistente que ajuda profissionais de saúde mental a relembrar e contextualizar o histórico de acompanhamento de UM paciente específico, ao longo de meses ou anos de sessões.

Você recebe abaixo um histórico estruturado das sessões anteriores: resumos, tópicos discutidos, compromissos assumidos, temas a retomar, e sinais clínicos extraídos automaticamente por IA (humor, ansiedade, sono, autoestima, nível de risco, eventos marcantes, temas recorrentes).

Princípios:
- Responda SOMENTE com base no histórico fornecido. Se não houver informação suficiente para responder, diga isso claramente — não invente.
- Português brasileiro, tom profissional e direto, falando diretamente com o profissional.
- Ao citar uma sessão específica, mencione a data.
- Ao identificar um padrão ou tema recorrente, diga em quantas sessões ou desde quando ele aparece.
- Os "sinais clínicos" são inferências automáticas de IA sobre cada sessão, não uma avaliação validada — trate como apoio à memória, e deixe claro quando a resposta depende desses sinais.
- Seja conciso: prefira 2-5 frases ou uma lista curta. Evite repetir o histórico inteiro.
- Texto plano apenas — NÃO use Markdown (sem **negrito**, *itálico*, #títulos ou \`código\`). A interface não renderiza Markdown, exibe o texto literal. Para listas, use "- " no início da linha.`;

const MAX_SESSIONS = 30;

function buildContext(entries, patientName) {
  const sliced = entries.slice(-MAX_SESSIONS);
  const omitted = entries.length - sliced.length;

  const lines = [];
  lines.push(`Histórico de sessões${patientName ? ` de ${patientName}` : ""} (ordem cronológica):`);
  if (omitted > 0) {
    lines.push(`(Mostrando as ${MAX_SESSIONS} sessões mais recentes de ${entries.length} no total.)`);
  }
  lines.push("");

  for (const e of sliced) {
    const date = e.completedAt
      ? new Date(e.completedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
      : "data desconhecida";
    lines.push(`## Sessão de ${date}`);

    const summary = e.summary || {};
    if (summary.summary) lines.push(`Resumo: ${summary.summary}`);

    if (Array.isArray(summary.topics) && summary.topics.length) {
      lines.push("Tópicos:");
      for (const t of summary.topics) lines.push(`- ${t.title}: ${t.summary}`);
    }
    if (Array.isArray(summary.commitments) && summary.commitments.length) {
      lines.push("Compromissos:");
      for (const c of summary.commitments) lines.push(`- ${c.who}: ${c.what}`);
    }
    if (Array.isArray(summary.followups) && summary.followups.length) {
      lines.push(`Retomar: ${summary.followups.join("; ")}`);
    }

    const s = e.signals;
    if (s) {
      const scales = [];
      if (Number.isFinite(s.mood)) scales.push(`humor ${s.mood}/10`);
      if (Number.isFinite(s.anxiety)) scales.push(`ansiedade ${s.anxiety}/10`);
      if (Number.isFinite(s.sleepQuality)) scales.push(`sono ${s.sleepQuality}/10`);
      if (Number.isFinite(s.selfEsteem)) scales.push(`autoestima ${s.selfEsteem}/10`);
      if (scales.length) lines.push(`Sinais: ${scales.join(", ")}`);

      if (s.riskLevel && s.riskLevel !== "none") {
        const factors = Array.isArray(s.riskFactors) && s.riskFactors.length ? ` (${s.riskFactors.join(", ")})` : "";
        lines.push(`Risco: ${s.riskLevel}${factors}`);
      }
      if (Array.isArray(s.notableEvents) && s.notableEvents.length) {
        lines.push(`Eventos marcantes: ${s.notableEvents.map(ev => ev.title).join("; ")}`);
      }
      if (Array.isArray(s.keyThemes) && s.keyThemes.length) {
        lines.push(`Temas: ${s.keyThemes.join(", ")}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Responde uma pergunta livre sobre o histórico de um paciente.
 *
 * @param {object} params
 * @param {string} params.question - pergunta do profissional
 * @param {Array<object>} params.entries - sessões com resumo+signals, ordem cronológica (asc)
 * @param {string} [params.patientName] - nome do paciente (contexto)
 * @returns {Promise<{ok: boolean, answer?: string, error?: string, usage?: object}>}
 */
async function askClinicalTwin({ question, entries, patientName }) {
  const client = getClient();
  if (!client) return { ok: false, error: "ANTHROPIC_NAO_CONFIGURADO" };
  if (!question || typeof question !== "string" || !question.trim()) {
    return { ok: false, error: "PERGUNTA_OBRIGATORIA" };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: "SEM_HISTORICO" };
  }

  const context = buildContext(entries, patientName);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: context, cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: question.trim() }]
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock) return { ok: false, error: "RESPOSTA_VAZIA" };

    return {
      ok: true,
      answer: textBlock.text,
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        cacheRead: response.usage?.cache_read_input_tokens || 0,
        cacheWrite: response.usage?.cache_creation_input_tokens || 0
      }
    };
  } catch (err) {
    return { ok: false, error: "ANTHROPIC_FALHOU", detail: err.message };
  }
}

module.exports = { askClinicalTwin };
