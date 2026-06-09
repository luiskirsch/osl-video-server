// Espaço Prelúdio — gera resumo estruturado de sessão a partir de transcript.
//
// Input: texto transcrito (do whisper.js) + contexto (nomes profissional/paciente)
// Output: JSON estruturado com summary, topics[], commitments[], followups[]
//
// Modelo: Claude Haiku 4.5 (claude-haiku-4-5)
// - Suficiente pra esta tarefa (resumo + extracao estruturada)
// - Custo baixo (~$0.01-0.02 por sessao 50min)
// - Suporta structured outputs (JSON schema)
//
// O resumo serve pra profissional ler ANTES da proxima sessao — recupera
// contexto rapido + lembra de compromissos que ficaram em aberto.

const Anthropic = require("@anthropic-ai/sdk");

let _client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

const SYSTEM_PROMPT = `Você é um assistente clínico que ajuda profissionais de saúde mental a recuperar o contexto de sessões anteriores.

Sua tarefa: a partir do transcript de uma sessão de telessaúde, gerar um resumo estruturado que o profissional vai ler ANTES da próxima sessão, além de sinais clínicos para acompanhamento longitudinal (timeline, gráficos de evolução, radar de risco).

Princípios:
- Foque em CONTEÚDO clínico relevante, não em filler verbal ("é", "tipo", "sabe", "uhum")
- Identifique COMPROMISSOS explícitos por pessoa ("vou tentar X até a próxima", "fica responsável por Y")
- Marque TEMAS A RETOMAR — assuntos importantes que não foram totalmente resolvidos
- Tom neutro e clínico, terceira pessoa, em português brasileiro
- Se o transcript estiver muito curto, vazio ou ininteligível, retorne summary explicando isso
- Aceite que o transcript pode ter erros de Whisper (palavras trocadas, nomes mal grafados) — use contexto pra interpretar

Sobre os SINAIS (campo "signals"):
- São inferências a partir do que foi dito NESTA sessão, não uma avaliação clínica validada — o profissional usa como apoio, não substitui julgamento clínico
- Use null em qualquer escala (mood, anxiety, sleepQuality, selfEsteem) se o transcript não trouxer indício suficiente — NÃO invente valores
- riskLevel reflete sinais de crise, ideação, autolesão ou recaída mencionados NESTA sessão — "none" é o padrão na ausência de qualquer sinal
- notableEvents captura marcos/eventos de vida relevantes pra uma timeline (separação, troca de medicação, alta, nova crise, etc.) — só inclua o que for novidade nesta sessão
- keyThemes são 1-4 temas centrais recorrentes (ex: "medo de abandono", "conflito com a mãe") — usados pra detectar padrões entre sessões ao longo do tempo`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Parágrafo de 3-5 frases resumindo o que foi discutido na sessão. Foco no que é clinicamente relevante."
    },
    topics: {
      type: "array",
      description: "Lista de tópicos/temas abordados na sessão, em ordem de relevância.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Nome curto do tópico (ex: 'Conflito com sogra', 'Insônia recorrente')" },
          summary: { type: "string", description: "1-2 frases resumindo a discussão deste tópico" }
        },
        required: ["title", "summary"]
      }
    },
    commitments: {
      type: "array",
      description: "Compromissos explícitos assumidos por participante durante a sessão. Cada item separado por quem assumiu.",
      items: {
        type: "object",
        properties: {
          who: { type: "string", description: "Quem assumiu: 'paciente', 'profissional' ou nome se identificado" },
          what: { type: "string", description: "O que vai fazer/tentar/estudar antes da próxima sessão" }
        },
        required: ["who", "what"]
      }
    },
    followups: {
      type: "array",
      description: "Temas que ficaram em aberto e merecem ser retomados na próxima sessão.",
      items: { type: "string" }
    },
    signals: {
      type: "object",
      description: "Sinais clínicos extraídos desta sessão para acompanhamento longitudinal (timeline, gráficos, radar de risco).",
      properties: {
        mood: {
          type: ["integer", "null"],
          description: "Humor geral do paciente nesta sessão, escala 0 (muito deprimido/desanimado) a 10 (eufórico/muito bem). null se não há indício suficiente."
        },
        anxiety: {
          type: ["integer", "null"],
          description: "Nível de ansiedade expresso nesta sessão, escala 0 (calmo) a 10 (pânico/crise). null se não há indício suficiente."
        },
        sleepQuality: {
          type: ["integer", "null"],
          description: "Qualidade do sono relatada, escala 0 (insônia severa) a 10 (sono ótimo). null se não foi mencionado."
        },
        selfEsteem: {
          type: ["integer", "null"],
          description: "Autoestima/autoimagem expressa nesta sessão, escala 0 (muito negativa) a 10 (muito positiva). null se não há indício suficiente."
        },
        riskLevel: {
          type: "string",
          enum: ["none", "low", "moderate", "high"],
          description: "Nível de risco de crise, ideação, autolesão ou recaída percebido nesta sessão. 'none' é o padrão."
        },
        riskFactors: {
          type: "array",
          items: { type: "string" },
          description: "Fatores que motivaram o riskLevel informado. Vazio se riskLevel for 'none'."
        },
        notableEvents: {
          type: "array",
          description: "Eventos/marcos de vida mencionados NESTA sessão, relevantes para a timeline do paciente (ex: 'Separação conjugal', 'Troca de medicação', 'Alta parcial'). Vazio se nada novo.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Título curto do evento (3-6 palavras)" },
              category: {
                type: "string",
                enum: ["marco_terapeutico", "evento_vida", "saude", "crise", "medicacao", "outro"]
              }
            },
            required: ["title", "category"]
          }
        },
        keyThemes: {
          type: "array",
          items: { type: "string" },
          description: "1-4 temas clínicos centrais desta sessão (ex: 'medo de abandono', 'conflito familiar'), usados para detectar padrões recorrentes entre sessões."
        }
      },
      required: ["mood", "anxiety", "sleepQuality", "selfEsteem", "riskLevel", "riskFactors", "notableEvents", "keyThemes"]
    }
  },
  required: ["summary", "topics", "commitments", "followups", "signals"]
};

/**
 * Gera resumo estruturado a partir de transcript de sessão.
 *
 * @param {object} params
 * @param {string} params.transcript - texto transcrito
 * @param {string} [params.professionalName] - nome do profissional (contexto)
 * @param {string} [params.patientName] - nome do paciente (contexto)
 * @param {number} [params.durationSec] - duração em segundos (contexto)
 * @returns {Promise<{ok: boolean, summary?: object, error?: string, usage?: object}>}
 */
async function summarizeSession({ transcript, professionalName, patientName, durationSec }) {
  const client = getClient();
  if (!client) return { ok: false, error: "ANTHROPIC_NAO_CONFIGURADO" };
  if (!transcript || typeof transcript !== "string" || transcript.trim().length < 30) {
    return { ok: false, error: "TRANSCRIPT_VAZIO_OU_CURTO" };
  }

  // Contexto adicional pro modelo entender quem é quem
  const contextLines = [];
  if (professionalName) contextLines.push(`Profissional: ${professionalName}`);
  if (patientName) contextLines.push(`Paciente: ${patientName}`);
  if (durationSec) contextLines.push(`Duração: ${Math.round(durationSec / 60)} minutos`);
  const contextBlock = contextLines.length ? `Contexto da sessão:\n${contextLines.join("\n")}\n\n` : "";

  const userMessage = `${contextBlock}Transcript da sessão:\n\n${transcript}`;

  try {
    // tool_use é a forma correta de forçar structured output no Claude.
    // output_config não é parâmetro válido da API e era silenciosamente ignorado.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: [{
        name: "session_summary",
        description: "Retorna o resumo estruturado da sessão clínica.",
        input_schema: RESPONSE_SCHEMA
      }],
      tool_choice: { type: "tool", name: "session_summary" }
    });

    const toolBlock = response.content.find(b => b.type === "tool_use" && b.name === "session_summary");
    if (!toolBlock) return { ok: false, error: "RESPOSTA_SEM_TOOL_USE" };

    return {
      ok: true,
      summary: toolBlock.input,
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0
      }
    };
  } catch (err) {
    return { ok: false, error: "ANTHROPIC_FALHOU", detail: err.message };
  }
}

module.exports = { summarizeSession };
