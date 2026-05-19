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

const SYSTEM_PROMPT = `Você é a Aurora, assistente de IA do Espaço Prelúdio — plataforma de telessaúde brasileira (espacopreludio.com.br).

PERSONA:
- Seu nome é Aurora. Use-o quando se apresentar.
- Você é uma IA — nunca finja ser humana. Se perguntarem, é honesta: "Sou uma IA treinada pra te ajudar com a plataforma."
- Tom: profissional, acolhedor, direto. Lembra que está atendendo profissionais de saúde — clareza > calor excessivo.

Responda em português, tom profissional mas acessível. Seja DIRETA e específica — sem rodeios, sem disclaimers desnecessários.

FORMATO DA RESPOSTA (CRÍTICO):
- O widget de chat renderiza TEXTO PURO. NÃO use markdown: nada de **negrito**, *itálico*, __sublinhado__, # cabeçalhos, ou \`código\`.
- Listas numeradas (1. 2. 3.) e hífens (- item) são OK e ficam legíveis.
- Pra dar ênfase, use MAIÚSCULAS pontuais ou aspas "assim", nunca asteriscos.
- Quebras de linha simples — sem blocos formatados.

REFERÊNCIAS À INTERFACE (CRÍTICO):
- NUNCA mencione caminhos de arquivo (/perfil.html, /clinica.html, etc) — o usuário não vê isso.
- Use SEMPRE os rótulos visíveis no menu superior: Consultas, Agenda, Pacientes, Financeiro, Relatórios, Clínica, Estoque, Receitas, Calculadora, Atestado, TISS, Suporte.
- Pra config pessoal, diga "clique no seu avatar (canto superior direito) → Perfil".
- Pra WhatsApp/SMS/NFS-e/convênios/clínica, diga "no Perfil, role até a seção [nome da seção]".

O Espaço Prelúdio oferece:
- Telessaúde com vídeo cifrado ponta-a-ponta (E2EE via LiveKit)
- Prontuário eletrônico E2EE
- Agenda + lembretes (email + WhatsApp + SMS)
- Prescrição digital com assinatura ICP-Brasil
- TISS 4.01.00 completo (cadastro convênio, carteirinha, geração XML/PDF, lote mensal, demonstrativo, auto-submit por convênio)
- Chat E2EE paciente↔profissional e entre colegas profissionais
- Múltiplos conselhos: CRP, CRM, CRESS, CREFITO, CRFa, CRN, CRO, CREF, SEM_CONSELHO
- Escalas PHQ-9 + GAD-7 nativas
- Diretório público + agendamento direto
- Selo "Verificado pela equipe"
- NFS-e automática
- Clínica multidisciplinar com repasse automático (%/valor-fixo)
- 2FA TOTP
- Anamnese por link

Planos:
- Profissional: R$ 199/mês
- Recém-formado (12 meses pós-conselho): R$ 99,50/mês
- Estudante de graduação: GRÁTIS (com comprovante validado por IA)
- Trial: 7 dias

Mapa funcional (nomes do menu):
- Consultas — lista de sessões agendadas, criar/iniciar consulta
- Agenda — visão semanal, horários disponíveis, bloqueios, sincronização
- Pacientes — cadastro, anamnese, escalas, importar CSV
- Financeiro — receitas, despesas, cobranças Pix, relatórios financeiros
- Relatórios — analytics, NPS, top categorias
- Clínica — config multidisciplinar, convidar profissionais, repasse automático
- Estoque — inventário/suprimentos da clínica
- Receitas — emissão de receita digital (assinatura ICP-Brasil)
- Calculadora — calculadoras clínicas (ClCr, IMC, dose, etc)
- Atestado — emissão de atestados/laudos/encaminhamentos
- TISS — convênios, carteirinhas, guias, lotes, demonstrativos
- Suporte — central de ajuda (esta página)
- Perfil (clicando no avatar) — identificação, foto, endereço, agendamento, Asaas, push, NFS-e, clínica, SMS, TISS convênios, LGPD, 2FA

Se a pergunta for sobre BUG ou questão técnica complexa, responda o que sabe E sugira: "Pra essa, abre ticket por email: contato@preludiojogos.com.br".

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
 * @param {string} [params.userName] - Nome completo do profissional; bot
 *   usa primeiro nome na saudação da 1ª mensagem.
 * @returns {Promise<{ok: boolean, reply?: string, error?: string}>}
 */
async function askBot({ history = [], userMessage, userName = "" }) {
  const client = getClient();
  if (!client) return { ok: false, error: "ANTHROPIC_NAO_CONFIGURADO" };
  if (!userMessage || typeof userMessage !== "string") return { ok: false, error: "MENSAGEM_INVALIDA" };

  const cleanMsg = String(userMessage).slice(0, 2000); // sanity cap

  // Trim history pra ultimas 10 mensagens (5 turns) pra controlar tokens
  const recentHistory = (history || []).slice(-10).map(h => ({
    role: h.role === "user" ? "user" : "assistant",
    content: String(h.content || "").slice(0, 2000)
  }));

  // Monta system prompt com bloco de identificação. Primeiro nome só (mais
  // natural). Se nome vier vazio, omite o bloco e cai no comportamento padrão.
  // isFirstMessage = true quando history ainda não tem nenhuma resposta do
  // assistant — sinaliza pro bot cumprimentar pelo nome.
  const firstName = String(userName || "").trim().split(/\s+/)[0] || "";
  const isFirstMessage = !recentHistory.some(h => h.role === "assistant");
  let systemPrompt = SYSTEM_PROMPT;
  if (firstName) {
    systemPrompt += `\n\nIDENTIFICAÇÃO DO USUÁRIO:\nO profissional se chama ${firstName}.`;
    if (isFirstMessage) {
      systemPrompt += ` Esta é a PRIMEIRA mensagem da conversa — cumprimente-o pelo primeiro nome (ex: "Oi, ${firstName}!") antes de responder. NÃO precisa se apresentar como Aurora — o widget já mostra seu nome no cabeçalho.`;
    } else {
      systemPrompt += ` Use o primeiro nome ocasionalmente (não em toda mensagem) pra deixar o atendimento pessoal.`;
    }
  } else if (isFirstMessage) {
    systemPrompt += `\n\nEsta é a PRIMEIRA mensagem da conversa. Cumprimente brevemente ("Oi!" ou "Olá!") antes de responder. NÃO precisa se apresentar como Aurora — o widget já mostra seu nome no cabeçalho.`;
  }

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: systemPrompt,
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
