// Espaço Prelúdio — Suporte 24/7 via chatbot Claude.
//
// Funcionamento:
//   - Profissional clica no bubble "?" no canto inferior direito de qualquer
//     pagina logada
//   - Bubble vira um chat ao vivo com IA respondendo
//   - Backend chama Claude Haiku 4.5 (modelo barato, rapido) com contexto da
//     plataforma + pergunta do user
//   - Respostas instantaneas 24/7 — bot sabe responder sobre features,
//     fluxos, troubleshooting comum
//
// Custos: Haiku 4.5 = ~$0.0008 por consulta tipica (300 tokens in + 200 out).
// Rate-limited: 30 perguntas/dia por user (custo maximo $0.72/user/mes).

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `Você é o assistente de suporte do Espaço Prelúdio — plataforma de telessaúde brasileira (espacopreludio.com.br).

Responda em português, tom profissional mas acessível. Seja DIRETO e específico — sem rodeios, sem disclaimers desnecessários.

O Espaço Prelúdio oferece:
- Telessaúde com vídeo cifrado ponta-a-ponta (E2EE via LiveKit)
- Prontuário eletrônico E2EE
- Agenda + lembretes (email + WhatsApp via Z-API + SMS via Twilio)
- Prescrição digital com assinatura ICP-Brasil
- TISS 4.01.00 completo (cadastro convênio, carteirinha, geração XML/PDF, lote mensal, demonstrativo, scaffolding auto-submit)
- Chat E2EE paciente↔profissional e profissional↔profissional ("Colegas")
- Múltiplos conselhos: CRP, CRM, CRESS, CREFITO, CRFa, CRN, CRO, CREF, SEM_CONSELHO
- Escalas PHQ-9 + GAD-7 nativas
- Diretório público + agendamento direto
- Selo "Verificado pela equipe"
- NFS-e via NFE.io
- Clínica multidisciplinar com repasse automático (%/valor-fixo)
- 2FA TOTP
- Anamnese por link

Planos:
- Profissional: R$ 199/mês
- Recém-formado (12 meses pós-conselho): R$ 99,50/mês
- Estudante de graduação: GRÁTIS (com comprovante validado por IA)
- Trial: 7 dias

Páginas principais:
- /painel.html — consultas
- /agenda.html — agenda semanal
- /pacientes.html — cadastro
- /prontuario.html — prontuário individual
- /financeiro.html — receitas/despesas
- /receita.html — emissão receita
- /documento.html — atestado/laudo
- /calculadora.html — calculadoras clínicas
- /tiss.html — guias TISS
- /mensagens.html — chat com pacientes
- /mensagens-pro.html — chat com colegas
- /perfil.html — config (NFS-e, WhatsApp, SMS, convênios, clínica)
- /whatsapp.html — config WhatsApp

Se a pergunta for sobre BUG ou questão técnica complexa, responda o que sabe E sugira escalar pra humano: "Pra essa, abre ticket por email no suporte humano: contato@preludiojogos.com.br"

Se for sobre processo regulatório (CFP, CFM, CFP Res 11/2018), responda baseado no conhecimento mas sempre sugira consultar o conselho específico pra dúvidas formais.

NUNCA invente features que não existem. Se não souber, diga "Não tenho certeza — pergunte no suporte humano: contato@preludiojogos.com.br".

Mantenha respostas curtas (3-6 frases máx) salvo quando o user pede passo-a-passo detalhado.`;

let _client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Responde uma pergunta do user. Mantém contexto via array de mensagens.
 *
 * @param {object} params
 * @param {Array<{role:"user"|"assistant", content:string}>} params.history
 * @param {string} params.userMessage
 * @returns {Promise<{ok: boolean, reply?: string, error?: string}>}
 */
async function askBot({ history = [], userMessage }) {
  const client = getClient();
  if (!client) return { ok: false, error: "ANTHROPIC_NAO_CONFIGURADO" };
  if (!userMessage || typeof userMessage !== "string") return { ok: false, error: "MENSAGEM_INVALIDA" };

  const cleanMsg = String(userMessage).slice(0, 2000); // sanity cap

  // Trim history pra ultimas 10 mensagens (5 turns) pra controlar tokens
  const recentHistory = (history || []).slice(-10).map(h => ({
    role: h.role === "user" ? "user" : "assistant",
    content: String(h.content || "").slice(0, 2000)
  }));

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        ...recentHistory,
        { role: "user", content: cleanMsg }
      ]
    });

    const text = response?.content?.[0]?.text || "";
    if (!text) return { ok: false, error: "RESPOSTA_VAZIA" };
    return {
      ok: true,
      reply: text,
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0
      }
    };
  } catch (err) {
    return { ok: false, error: "ANTHROPIC_FALHOU", detail: err.message };
  }
}

module.exports = { askBot };
