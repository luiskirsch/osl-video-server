// Espaço Prelúdio — Aurora, assistente 24/7 via Claude.
//
// Funcionamento:
//   - Profissional abre o bubble no canto inferior direito de qualquer página
//     logada e conversa com a Aurora
//   - Backend chama Claude com o contexto da plataforma + ferramentas que
//     leem dados reais da conta de quem pergunta (services/support-tools.js):
//     agenda, status da conta/pendências e novidades publicadas
//   - Histórico fica no cliente; backend é stateless por pergunta
//
// Custos: Opus 5.5 em esforço baixo, prompt fixo em cache. Pergunta sem
// ferramenta ~US$ 0,01; com 1-2 consultas ~US$ 0,02-0,04. Rate-limited em
// 30 perguntas/dia por usuário na rota.

const Anthropic = require("@anthropic-ai/sdk");
const { logError, logInfo } = require("../logger");

const MODEL = "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 4;

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

LINKS CLICÁVEIS:
- Pra levar o usuário direto a uma tela, escreva o nome dela entre colchetes duplos: [[Consultas]], [[Agenda]], [[Pacientes]], [[Financeiro]], [[Relatórios]], [[Clínica]], [[Estoque]], [[Receitas]], [[Calculadora]], [[TISS]], [[Suporte]], [[Perfil]]. O widget transforma em link.
- Só esses nomes funcionam. Use no máximo 2 por resposta, quando ajudar a pessoa a agir.

FERRAMENTAS (dados reais da conta de quem está conversando):
- ver_agenda — sessões do profissional por período (data, hora, paciente, status, duração).
- ver_status_da_conta — plano, se as consultas estão liberadas, fim do teste, selo de verificação, itens do perfil faltando e integrações ativas.
- propor_agendamento — prepara uma nova consulta e mostra um cartão de confirmação no chat.
- ver_novidades — mudanças publicadas recentemente na plataforma.
Regras:
- Quando a pergunta depende de dados da conta ou de novidades, CONSULTE a ferramenta antes de responder. Nunca invente horários, pacientes, planos ou atualizações.
- As ferramentas só enxergam a conta de quem conversa com você. Você NÃO tem acesso a prontuários, anotações clínicas, conversas com pacientes, documentos ou resumos de sessão — são cifrados e nem o servidor lê. Se pedirem, explique isso e indique onde ver.
- Ao citar pacientes, use o nome exatamente como veio da ferramenta.
- Em novidades, traduza as mensagens técnicas em benefícios práticos ("agora X funciona assim"), agrupe itens parecidos, destaque as 3 a 5 mais relevantes com a data e omita termos de programação.
- Se uma ferramenta falhar, diga que não conseguiu consultar agora — não chute.

AGENDAR CONSULTAS:
- Quando pedirem para agendar/marcar, você precisa de paciente, data e hora. Se faltar algum, pergunte (uma pergunta curta) antes de chamar propor_agendamento.
- Resolva datas relativas ("hoje", "amanhã", "sexta") a partir do "Agora" do contexto. Hora sem minutos = hora cheia ("12h" = 12:00). "Meio-dia" = 12:00.
- Você participa do agendamento: propõe os dados e exibe o cartão; a consulta é efetivamente criada quando o profissional clica em Confirmar. Antes desse clique, nunca diga que já agendou. Depois da confirmação, reconheça normalmente que a consulta foi agendada por meio do seu cartão — se o profissional disser "a consulta que você marcou/agendou", NÃO o corrija nem negue sua participação.
- Ao confirmar, o próprio cartão da Aurora mostra o link da consulta para copiar ou abrir. Depois, o profissional também pode recuperá-lo em [[Agenda]]: clique na consulta e use "Copiar link". O link do paciente NÃO fica em Consultas.
- Se perguntarem onde está o link de uma consulta recém-confirmada, diga primeiro que ele está no cartão de confirmação logo acima; como alternativa, explique o caminho em [[Agenda]]. Não encaminhe ao suporte humano por essa dúvida.
- Se a ferramenta apontar conflito de horário, avise qual é. Se devolver erro (horário passado, plano bloqueado), explique e não insista.
- Para mudar algo, é só chamar de novo com os dados corrigidos. Remarcar ou cancelar consultas existentes você não faz: indique [[Consultas]].

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
- Resumo por IA da sessão (opcional, com consentimento do paciente)

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

Se a pergunta for sobre BUG ou questão técnica complexa, responda o que sabe E sugira: "Pra essa, abre ticket por email: contato@espacopreludio.com.br".

Se for sobre processo regulatório (CFP, CFM, CFP Res 11/2018), responda baseado no conhecimento mas sempre sugira consultar o conselho específico pra dúvidas formais.

NUNCA invente features que não existem. Se não souber, diga "Não tenho certeza — pergunte no suporte humano: contato@espacopreludio.com.br".

Mantenha respostas curtas (3-6 frases máx) salvo quando o user pede passo-a-passo detalhado ou uma lista da agenda.`;

const PAGE_LABELS = {
  "/painel.html": "Consultas",
  "/agenda.html": "Agenda",
  "/pacientes.html": "Pacientes",
  "/prontuario.html": "Prontuário de um paciente",
  "/financeiro.html": "Financeiro",
  "/relatorios.html": "Relatórios",
  "/clinica.html": "Clínica",
  "/inventario.html": "Estoque",
  "/receita.html": "Receitas",
  "/calculadora.html": "Calculadora",
  "/tiss.html": "TISS",
  "/suporte.html": "Suporte",
  "/perfil.html": "Perfil",
  "/consultorio.html": "Sala de consulta"
};

const REFUSAL_REPLY = "Não consigo ajudar com esse pedido por aqui. Se for algo da plataforma, me conte de outro jeito ou escreva para contato@espacopreludio.com.br.";


let _client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return _client;
}

function pageLabel(page) {
  const path = String(page || "").split(/[?#]/)[0].replace(/^\/staging(?=\/)/, "");
  return PAGE_LABELS[path] || null;
}

// Contexto por pergunta fica num bloco separado, depois do prompt fixo em
// cache — mudar nome/hora/tela não invalida o cache do prompt principal.
const LANGUAGE_NAMES = { "en-US": "inglês (English)", "es-ES": "espanhol (Español)" };

function buildContext({ userName, isFirstMessage, page, now, timeZone = "America/Sao_Paulo", locale = "pt-BR" }) {
  const firstName = (String(userName || "").trim().split(/\s+/)[0] || "")
    .replace(/[^\p{L}'-]/gu, "")
    .slice(0, 40);
  const nowText = new Intl.DateTimeFormat("pt-BR", {
    timeZone, weekday: "long", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(now));
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const lines = [`CONTEXTO DESTA PERGUNTA:`, `- Agora: ${nowText} (${isoDate}, fuso ${timeZone}).`];
  const label = pageLabel(page);
  if (label) lines.push(`- O profissional está na tela: ${label}.`);
  if (firstName) {
    lines.push(`- O profissional se chama ${firstName}.`);
    lines.push(isFirstMessage
      ? `- Esta é a PRIMEIRA mensagem da conversa — cumprimente-o pelo primeiro nome (ex: "Oi, ${firstName}!") antes de responder. NÃO precisa se apresentar como Aurora — o widget já mostra seu nome no cabeçalho.`
      : `- Use o primeiro nome ocasionalmente (não em toda mensagem) pra deixar o atendimento pessoal.`);
  } else if (isFirstMessage) {
    lines.push(`- Esta é a PRIMEIRA mensagem da conversa. Cumprimente brevemente ("Oi!" ou "Olá!") antes de responder. NÃO precisa se apresentar como Aurora — o widget já mostra seu nome no cabeçalho.`);
  }
  // Interface em outro idioma: a resposta segue o idioma da tela.
  if (LANGUAGE_NAMES[locale]) {
    lines.push(`- IDIOMA: a interface do profissional está em ${LANGUAGE_NAMES[locale]}. Responda SEMPRE nesse idioma, inclusive na saudação.`);
  }
  return lines.join("\n");
}

// Após um fallback no meio da resposta, blocos de raciocínio e tool_use
// anteriores à troca de modelo não podem voltar no histórico.
function echoableContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  let boundary = -1;
  blocks.forEach((block, index) => { if (block?.type === "fallback") boundary = index; });
  if (boundary < 0) return blocks;
  const dropBeforeBoundary = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);
  return blocks.filter((block, index) => index >= boundary || !dropBeforeBoundary.has(block?.type));
}

function extractText(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

/**
 * Responde uma pergunta do user, consultando as ferramentas quando preciso.
 *
 * @param {object} params
 * @param {Array<{role:"user"|"assistant", content:string}>} params.history
 * @param {string} params.userMessage
 * @param {string} [params.userName] - Nome do profissional; bot usa o
 *   primeiro nome na saudação da 1ª mensagem.
 * @param {string} [params.page] - Caminho da tela atual (ex.: "/agenda.html").
 * @param {string} [params.timeZone] - Fuso IANA do navegador (já validado).
 * @param {{definitions: object[], run: Function}} [params.tools] - Ferramentas
 *   já presas ao usuário autenticado (services/support-tools.js).
 * @returns {Promise<{ok: boolean, reply?: string, error?: string, usage?: object, toolsUsed?: string[]}>}
 */
async function askBot({ history = [], userMessage, userName = "", page = "", timeZone = "America/Sao_Paulo", locale = "pt-BR", tools = null, client = getClient(), now = Date.now() }) {
  if (!client) return { ok: false, error: "ANTHROPIC_NAO_CONFIGURADO" };
  if (!userMessage || typeof userMessage !== "string") return { ok: false, error: "MENSAGEM_INVALIDA" };

  const cleanMsg = String(userMessage).slice(0, 2000); // sanity cap

  // Trim history pra ultimas 10 mensagens (5 turns) pra controlar tokens
  const recentHistory = (Array.isArray(history) ? history : [])
    .filter(h => h?.role === "user" || h?.role === "assistant")
    .slice(-10)
    .map(h => ({
      role: h.role,
      content: String(h.content || "").replace(/\u0000/g, "").slice(0, 2000)
    }))
    .filter(h => h.content.trim());
  // A API exige começar por mensagem do usuário.
  while (recentHistory.length && recentHistory[0].role !== "user") recentHistory.shift();

  const isFirstMessage = !recentHistory.some(h => h.role === "assistant");
  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildContext({ userName, isFirstMessage, page, now, timeZone, locale }) }
  ];
  const messages = [...recentHistory, { role: "user", content: cleanMsg }];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const toolsUsed = [];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system,
        ...(tools ? { tools: tools.definitions } : {}),
        messages
      });
      usage.input += response.usage?.input_tokens || 0;
      usage.output += response.usage?.output_tokens || 0;
      usage.cacheRead += response.usage?.cache_read_input_tokens || 0;

      if (response.stop_reason === "refusal") {
        logInfo("support_bot_refusal", { category: response.stop_details?.category || null });
        return { ok: true, reply: REFUSAL_REPLY, usage, toolsUsed };
      }

      const content = echoableContent(response.content);
      const toolUses = content.filter(block => block.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !tools || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        const text = extractText(content);
        if (!text) return { ok: false, error: round === MAX_TOOL_ROUNDS ? "LIMITE_FERRAMENTAS" : "RESPOSTA_VAZIA" };
        return { ok: true, reply: text, usage, toolsUsed };
      }

      messages.push({ role: "assistant", content });
      const results = await Promise.all(toolUses.map(async block => {
        toolsUsed.push(block.name);
        const result = await tools.run(block.name, block.input);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        };
      }));
      messages.push({ role: "user", content: results });
    }
    return { ok: false, error: "LIMITE_FERRAMENTAS" };
  } catch (err) {
    logError("support_bot_anthropic_failed", err);
    return { ok: false, error: "ANTHROPIC_FALHOU" };
  }
}

module.exports = { askBot, _test: { buildContext, echoableContent, extractText, pageLabel } };
