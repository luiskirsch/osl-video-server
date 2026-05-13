// Template fixo + validação de anamnese pré-consulta.
//
// MVP: template único pra psicologia/terapia. V2 permitirá customização
// por terapeuta. Schema flat de pares { questionId, type, label, required }
// — frontend renderiza dinamicamente.

const ANAMNESE_TEMPLATE_V1 = [
  { id: "nomeCompleto",      type: "text",     label: "Seu nome completo",                                                                 required: true,  maxLen: 120 },
  { id: "dataNascimento",    type: "date",     label: "Data de nascimento",                                                                required: true },
  { id: "profissao",         type: "text",     label: "Profissão ou ocupação atual",                                                       required: false, maxLen: 120 },
  { id: "estadoCivil",       type: "select",   label: "Estado civil",                                                                       required: false, options: ["solteiro(a)", "casado(a)", "união estável", "divorciado(a)", "viúvo(a)", "outro"] },
  { id: "comoTemSentido",    type: "textarea", label: "Como você tem se sentido nas últimas semanas?",                                     required: true,  maxLen: 2000 },
  { id: "motivoBusca",       type: "textarea", label: "O que te trouxe à terapia agora? Quando começou?",                                  required: true,  maxLen: 2000 },
  { id: "terapiaAnterior",   type: "radio",    label: "Já fez terapia antes?",                                                              required: true,  options: ["sim", "não"] },
  { id: "terapiaDetalhes",   type: "textarea", label: "Se sim, conte um pouco (por quanto tempo, abordagem, motivos)",                     required: false, maxLen: 1000, dependsOn: { questionId: "terapiaAnterior", value: "sim" } },
  { id: "medicacao",         type: "textarea", label: "Faz uso de alguma medicação atualmente? (incluindo psiquiátrica)",                  required: false, maxLen: 1000 },
  { id: "condicoesSaude",    type: "textarea", label: "Tem alguma condição de saúde relevante? Alergias?",                                  required: false, maxLen: 1000 },
  { id: "habitos",           type: "textarea", label: "Como estão seus hábitos? (sono, alimentação, álcool, outras substâncias, exercícios)", required: false, maxLen: 1500 },
  { id: "expectativas",      type: "textarea", label: "O que você espera da terapia? Tem alguma meta específica?",                          required: false, maxLen: 1500 },
  { id: "algoMais",          type: "textarea", label: "Algo mais que você ache importante compartilhar antes da primeira sessão?",          required: false, maxLen: 2000 }
];

const ANAMNESE_TEMPLATE_VERSION = "v1";

function getTemplate(version) {
  if (version === "v1" || !version) return { version: "v1", questions: ANAMNESE_TEMPLATE_V1 };
  return null;
}

// Valida responses contra o template. Retorna { ok, errors[] } e clean
// (objeto sanitizado com apenas campos válidos, strings trimmadas/limit).
function validateResponses(responses, template) {
  const errors = [];
  const clean = {};
  if (!template || !Array.isArray(template.questions)) {
    return { ok: false, errors: ["TEMPLATE_INVALIDO"], clean: {} };
  }
  const respMap = responses && typeof responses === "object" ? responses : {};

  // Dependências resolvidas com lookup no respMap (não no clean — usuário pode
  // não ter respondido na ordem). Resposta vazia em dependência opcional é OK.
  function isVisible(q) {
    if (!q.dependsOn) return true;
    const parent = String(respMap[q.dependsOn.questionId] ?? "").trim().toLowerCase();
    return parent === String(q.dependsOn.value).toLowerCase();
  }

  for (const q of template.questions) {
    if (!isVisible(q)) continue;
    const raw = respMap[q.id];
    if (q.type === "radio" || q.type === "select") {
      const v = String(raw == null ? "" : raw).trim().toLowerCase();
      if (!v) {
        if (q.required) errors.push(`${q.id}: obrigatório`);
        continue;
      }
      const opts = (q.options || []).map(o => String(o).toLowerCase());
      if (!opts.includes(v)) {
        errors.push(`${q.id}: valor inválido`);
        continue;
      }
      clean[q.id] = v;
    } else if (q.type === "date") {
      const v = String(raw == null ? "" : raw).trim();
      if (!v) {
        if (q.required) errors.push(`${q.id}: obrigatório`);
        continue;
      }
      // YYYY-MM-DD bem leniente — não rejeita parsing exato, deixa o pdf
      // formatar bonito depois.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        errors.push(`${q.id}: formato data inválido (use AAAA-MM-DD)`);
        continue;
      }
      clean[q.id] = v;
    } else {
      // text | textarea
      const v = String(raw == null ? "" : raw).trim();
      if (!v) {
        if (q.required) errors.push(`${q.id}: obrigatório`);
        continue;
      }
      const maxLen = Number.isFinite(q.maxLen) ? q.maxLen : 2000;
      clean[q.id] = v.slice(0, maxLen);
    }
  }

  return { ok: errors.length === 0, errors, clean };
}

// Retorno-amigável: "Como você tem se sentido?" → resposta. Usado no e-mail
// de notificação + na renderização do prontuário.
function formatForDisplay(responses, template) {
  if (!template || !Array.isArray(template.questions)) return [];
  const out = [];
  for (const q of template.questions) {
    const v = responses?.[q.id];
    if (v === undefined || v === null || v === "") continue;
    let display = String(v);
    if (q.type === "radio" || q.type === "select") {
      display = display.charAt(0).toUpperCase() + display.slice(1);
    }
    out.push({ id: q.id, label: q.label, value: display, type: q.type });
  }
  return out;
}

module.exports = {
  ANAMNESE_TEMPLATE_VERSION,
  getTemplate,
  validateResponses,
  formatForDisplay
};
