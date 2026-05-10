// services/document-validator.js
//
// Validação automatizada de declaração de matrícula (clínica-escola/último ano de
// Psicologia ou Medicina) para liberação do tier "estudante" do Espaço Prelúdio.
//
// Strategy pattern — provider default: claude-vision (Anthropic Claude Sonnet 4.6).
// Troca via env DOC_VALIDATOR_PROVIDER (claude | mock).
//
// Resposta uniforme:
//   {
//     ok: bool,
//     decision: "approved" | "rejected" | "manual-review",
//     confidence: 0..1,
//     reasons: string[],          // motivos legíveis (PT)
//     extracted: {                // campos extraídos do documento
//       nome, cpf, curso, semestre, instituicao,
//       dataEmissao (ISO 8601 ou null), situacao,
//       isUltimoAno (bool), cursoElegivel (bool)
//     },
//     provider: string,
//     raw?: any                   // resposta crua do LLM (para debug/auditoria)
//   }
//
// O caller decide o que fazer com `decision`:
//   - "approved"      → libera plano student-active
//   - "rejected"      → bloqueia, mostra reasons ao usuário
//   - "manual-review" → coloca na fila admin

const Anthropic = require("@anthropic-ai/sdk");
const { logError, logInfo } = require("../logger");
const { ANTHROPIC_API_KEY } = require("../config");
const { ALL_SIGLAS, isValidSigla, normalizeSigla } = require("./professional-councils");

// Cursos elegíveis pro tier estudante (clínica-escola é coisa de Psicologia,
// mas internato/estágio supervisionado de Medicina também conta porque eles
// atendem em ambulatório-escola no último ano).
const CURSOS_ELEGIVEIS = ["psicologia", "medicina"];

// Janela máxima de validade do comprovante: 90 dias após emissão.
// Acima disso, mesmo se autêntico, exigimos comprovante atualizado.
const DOC_VALIDITY_DAYS = 90;

// Threshold pra aprovação automática. Abaixo, vai pra revisão manual.
const AUTO_APPROVE_CONFIDENCE = 0.85;
// Abaixo disso, rejeita direto sem revisão (provavelmente não é um doc válido).
const REJECT_CONFIDENCE = 0.40;

// Tier "recém-formado": elegível se inscrição CRP/CRM <= N meses atrás.
const RECEM_FORMADO_MAX_MONTHS = 12;

// Modelo Claude com visão. Sonnet 4.6 = melhor custo-benefício pra OCR estruturado.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;

class BaseValidator {
  constructor(name) { this.name = name; }
  // eslint-disable-next-line no-unused-vars
  async validate(_input) {
    throw new Error("NOT_IMPLEMENTED");
  }
}

// Mock — usado se o provider não tá configurado. Sempre manda pra revisão manual.
class MockValidator extends BaseValidator {
  constructor() { super("mock"); }
  async validate({ fileBase64, mediaType, expectedName }) {
    return {
      ok: true,
      decision: "manual-review",
      confidence: 0,
      reasons: ["validador automático não configurado — admin precisa revisar manualmente"],
      extracted: emptyExtracted(),
      provider: "mock",
      raw: { fileSize: fileBase64?.length || 0, mediaType, expectedName }
    };
  }
  async validateRegistration({ fileBase64, mediaType, expectedName }) {
    return {
      ok: true,
      decision: "manual-review",
      confidence: 0,
      reasons: ["validador automático não configurado — admin precisa revisar manualmente"],
      extracted: emptyRegistrationExtracted(),
      provider: "mock",
      raw: { fileSize: fileBase64?.length || 0, mediaType, expectedName }
    };
  }
}

class ClaudeVisionValidator extends BaseValidator {
  constructor(apiKey) {
    super("claude-vision");
    this.client = new Anthropic({ apiKey });
  }

  // Helper privado: chama Claude com visão e retorna JSON parseado.
  // Em caso de erro, retorna { error: <decision-result> } pro caller.
  async _callClaude({ prompt, fileBase64, mediaType, requestId, emptyFallback }) {
    let msg;
    try {
      msg = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: "user",
          content: [
            {
              type: mediaType === "application/pdf" ? "document" : "image",
              source: { type: "base64", media_type: mediaType, data: fileBase64 }
            },
            { type: "text", text: prompt }
          ]
        }]
      });
    } catch (error) {
      logError("doc_validator_anthropic_failed", error, { requestId });
      return { error: {
        ok: false,
        decision: "manual-review",
        confidence: 0,
        reasons: ["erro ao chamar serviço de validação — revisão manual"],
        extracted: emptyFallback(),
        provider: this.name,
        raw: { error: error.message }
      }};
    }

    const text = msg?.content?.[0]?.text || "{}";
    try {
      const cleaned = text.replace(/```json\s*|```\s*$/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : {};
      return { parsed };
    } catch (error) {
      logError("doc_validator_json_parse_failed", error, { requestId, text: text.slice(0, 500) });
      return { error: {
        ok: false,
        decision: "manual-review",
        confidence: 0,
        reasons: ["resposta inválida do validador — revisão manual"],
        extracted: emptyFallback(),
        provider: this.name,
        raw: { rawText: text }
      }};
    }
  }

  async validate({ fileBase64, mediaType, expectedName, expectedCpf, requestId = "" }) {
    if (!fileBase64) return rejected({ reason: "ARQUIVO_AUSENTE", provider: this.name });
    if (!isImageOrPdf(mediaType)) return rejected({ reason: "FORMATO_NAO_SUPORTADO", provider: this.name });

    const result = await this._callClaude({
      prompt: buildPrompt({ expectedName, expectedCpf }),
      fileBase64, mediaType, requestId,
      emptyFallback: emptyExtracted
    });
    if (result.error) return result.error;
    const parsed = result.parsed;

    const extracted = normalizeExtracted(parsed);
    const verdict = applyValidationRules({ extracted, expectedName, expectedCpf, llmConfidence: parsed.confidence });

    logInfo("doc_validator_claude_done", {
      requestId,
      decision: verdict.decision,
      confidence: verdict.confidence,
      curso: extracted.curso,
      isUltimoAno: extracted.isUltimoAno
    });

    return {
      ok: true,
      ...verdict,
      extracted,
      provider: this.name,
      raw: { llmRaw: parsed, model: MODEL }
    };
  }

  // Valida comprovante de registro profissional (carteira do conselho ou print
  // do sistema oficial). Aceita qualquer conselho suportado (CRP, CRM, CRESS,
  // CREFITO, CRFa, CRN, CRO, CREF). Extrai a data de inscrição no conselho.
  // Decisão automática:
  //   inscrição <= 12 meses atrás + confiança alta → approved (recém-formado)
  //   inscrição > 12 meses atrás                   → rejected (não é recém-formado)
  //   confiança intermediária                       → manual-review
  //
  // Params:
  //   expectedConselho — sigla esperada (CRP, CRM, CRESS, ...). Se ausente,
  //                      aceita qualquer conselho válido.
  //   expectedRegistro — número esperado. Match fuzzy ignora formatação/UF.
  async validateRegistration({
    fileBase64, mediaType, expectedName,
    expectedConselho, expectedRegistro,
    expectedCrp, expectedCrm,  // legados — usados se expectedConselho ausente
    requestId = ""
  }) {
    if (!fileBase64) return rejected({ reason: "ARQUIVO_AUSENTE", provider: this.name });
    if (!isImageOrPdf(mediaType)) return rejected({ reason: "FORMATO_NAO_SUPORTADO", provider: this.name });

    // Compat: se vier { expectedCrp } sem expectedConselho, mapeia.
    let conselhoEsperado = expectedConselho ? normalizeSigla(expectedConselho) : "";
    let registroEsperado = String(expectedRegistro || "").trim();
    if (!conselhoEsperado && expectedCrp) { conselhoEsperado = "CRP"; registroEsperado = String(expectedCrp).trim(); }
    if (!conselhoEsperado && expectedCrm) { conselhoEsperado = "CRM"; registroEsperado = String(expectedCrm).trim(); }

    const result = await this._callClaude({
      prompt: buildRegistrationPrompt({ expectedName, expectedConselho: conselhoEsperado, expectedRegistro: registroEsperado }),
      fileBase64, mediaType, requestId,
      emptyFallback: emptyRegistrationExtracted
    });
    if (result.error) return result.error;
    const parsed = result.parsed;

    const extracted = normalizeRegistrationExtracted(parsed);
    const verdict = applyRegistrationValidationRules({
      extracted,
      expectedName,
      expectedConselho: conselhoEsperado,
      expectedRegistro: registroEsperado,
      llmConfidence: parsed.confidence
    });

    logInfo("doc_validator_registration_done", {
      requestId,
      decision: verdict.decision,
      confidence: verdict.confidence,
      conselho: extracted.conselho,
      monthsSinceInscricao: extracted.monthsSinceInscricao
    });

    return {
      ok: true,
      ...verdict,
      extracted,
      provider: this.name,
      raw: { llmRaw: parsed, model: MODEL }
    };
  }
}

function buildPrompt({ expectedName, expectedCpf }) {
  return `Você é um validador de documentos acadêmicos brasileiros. Recebeu uma DECLARAÇÃO DE MATRÍCULA emitida por instituição de ensino superior.

Sua tarefa: extrair dados estruturados e avaliar autenticidade. Responda APENAS com JSON válido, sem markdown, no schema abaixo:

{
  "nome": "nome completo do aluno como aparece no doc",
  "cpf": "CPF se aparecer (apenas dígitos), ou null",
  "curso": "nome do curso (ex: 'Psicologia', 'Medicina', 'Direito'...)",
  "semestre": "semestre/período cursado (ex: '9º semestre', '5º ano')",
  "instituicao": "nome completo da instituição",
  "dataEmissao": "data de emissão do documento em formato ISO YYYY-MM-DD, ou null",
  "situacao": "status da matrícula (ex: 'matriculado', 'ativo', 'trancado', 'cancelado')",
  "isUltimoAno": true/false,
  "confidence": 0.0 a 1.0,
  "observacoes": "qualquer detalhe relevante: assinatura ICP-Brasil presente, QR code, marca d'água, sinais de adulteração, etc"
}

Regras de avaliação:
1. "isUltimoAno" = true SOMENTE se o semestre/período é claramente o último ou penúltimo do curso. Considere: Psicologia tem 10 semestres (5 anos), Medicina tem 12 semestres (6 anos). Logo, "último ano" = 9º-10º semestre de Psico, 11º-12º semestre de Medicina.
2. "confidence" = sua confiança de que este é um documento autêntico, recente, de pessoa real, em situação ativa. Reduza se: layout suspeito, fontes inconsistentes, assinaturas faltando, datas zoadas, qualidade de imagem ruim a ponto de impedir leitura.
3. ${expectedName ? `O nome esperado no documento é: "${expectedName}". Se não bater (case-insensitive, considere acentos/abreviações), reduza confidence drasticamente.` : ""}
4. ${expectedCpf ? `O CPF esperado é: ${expectedCpf}. Se aparecer e não bater, reduza confidence drasticamente.` : ""}
5. Não invente dados. Se não conseguir ler um campo, retorne null ou string vazia.
6. Se o documento não é uma declaração de matrícula (ex: histórico, comprovante de pagamento), retorne confidence ≤ 0.2.`;
}

function applyValidationRules({ extracted, expectedName, expectedCpf, llmConfidence }) {
  const reasons = [];
  let confidence = clamp01(Number(llmConfidence) || 0);

  if (!extracted.curso) {
    reasons.push("curso não identificado no documento");
    confidence = Math.min(confidence, 0.3);
  } else if (!extracted.cursoElegivel) {
    reasons.push(`curso "${extracted.curso}" não é elegível (apenas Psicologia ou Medicina)`);
    return { decision: "rejected", confidence: 0, reasons };
  }

  if (extracted.situacao && /trancado|cancelado|inativo|desligado/i.test(extracted.situacao)) {
    reasons.push(`matrícula em situação "${extracted.situacao}" — não elegível`);
    return { decision: "rejected", confidence: 0, reasons };
  }

  if (!extracted.isUltimoAno) {
    reasons.push("aluno não está no último ano do curso (necessário para clínica-escola/internato)");
    confidence = Math.min(confidence, 0.4);
  }

  if (extracted.dataEmissao) {
    const days = daysSince(extracted.dataEmissao);
    if (days === null) {
      reasons.push("data de emissão em formato inválido");
      confidence = Math.min(confidence, 0.5);
    } else if (days > DOC_VALIDITY_DAYS) {
      reasons.push(`comprovante emitido há ${days} dias (validade máxima: ${DOC_VALIDITY_DAYS} dias)`);
      return { decision: "rejected", confidence: 0, reasons };
    } else if (days < 0) {
      reasons.push("data de emissão no futuro — suspeito");
      confidence = Math.min(confidence, 0.3);
    }
  } else {
    reasons.push("data de emissão não identificada");
    confidence = Math.min(confidence, 0.5);
  }

  if (expectedName && extracted.nome) {
    if (!fuzzyNameMatch(expectedName, extracted.nome)) {
      reasons.push(`nome no documento ("${extracted.nome}") não bate com cadastro ("${expectedName}")`);
      return { decision: "rejected", confidence: 0, reasons };
    }
  }

  if (expectedCpf && extracted.cpf) {
    const cleanExpected = String(expectedCpf).replace(/\D/g, "");
    const cleanFound = String(extracted.cpf).replace(/\D/g, "");
    if (cleanExpected && cleanFound && cleanExpected !== cleanFound) {
      reasons.push("CPF no documento não bate com cadastro");
      return { decision: "rejected", confidence: 0, reasons };
    }
  }

  let decision;
  if (confidence >= AUTO_APPROVE_CONFIDENCE && reasons.length === 0) {
    decision = "approved";
    reasons.push("aprovado automaticamente: documento autêntico, dados consistentes, último ano em curso elegível");
  } else if (confidence < REJECT_CONFIDENCE) {
    decision = "rejected";
    reasons.unshift("confiança muito baixa para considerar este documento autêntico");
  } else {
    decision = "manual-review";
    reasons.unshift("confiança intermediária — admin vai revisar antes de liberar");
  }

  return { decision, confidence, reasons };
}

function normalizeExtracted(raw) {
  const curso = String(raw.curso || "").trim();
  const cursoLower = curso.toLowerCase();
  const cursoElegivel = CURSOS_ELEGIVEIS.some(c => cursoLower.includes(c));

  return {
    nome: String(raw.nome || "").trim(),
    cpf: String(raw.cpf || "").replace(/\D/g, "") || null,
    curso,
    cursoElegivel,
    semestre: String(raw.semestre || "").trim(),
    instituicao: String(raw.instituicao || "").trim(),
    dataEmissao: parseIsoDate(raw.dataEmissao),
    situacao: String(raw.situacao || "").trim(),
    isUltimoAno: !!raw.isUltimoAno,
    observacoes: String(raw.observacoes || "").trim().slice(0, 500)
  };
}

function emptyExtracted() {
  return {
    nome: "", cpf: null, curso: "", cursoElegivel: false,
    semestre: "", instituicao: "", dataEmissao: null, situacao: "",
    isUltimoAno: false, observacoes: ""
  };
}

// ─── Registration (CRP/CRM) helpers ─────────────────────────────────────

function buildRegistrationPrompt({ expectedName, expectedConselho, expectedRegistro }) {
  return `Você é um validador de registros profissionais brasileiros. Recebeu um documento que pode ser:
- Carteira/cédula profissional emitida por um conselho de classe
- Print de sistema oficial de busca do conselho (e-Psi/CFP, portal CFM, CFESS, COFFITO, CFFa, CFN, CFO, CONFEF)
- Declaração/certidão de inscrição no conselho

Conselhos suportados (extraia a sigla EXATA desta lista; nunca invente):
- CRP   — Conselho Regional de Psicologia (psicólogos)
- CRM   — Conselho Regional de Medicina (médicos, psiquiatras)
- CRESS — Conselho Regional de Serviço Social (assistentes sociais)
- CREFITO — Conselho Regional de Fisioterapia e Terapia Ocupacional (fisioterapeutas, TOs)
- CRFA  — Conselho Regional de Fonoaudiologia (fonoaudiólogos; também grafado "CRFa")
- CRN   — Conselho Regional de Nutricionistas (nutricionistas)
- CRO   — Conselho Regional de Odontologia (cirurgiões-dentistas)
- CREF  — Conselho Regional de Educação Física (profissionais de Educação Física)

Sua tarefa: extrair dados estruturados e a DATA DE INSCRIÇÃO no conselho. Responda APENAS com JSON válido, sem markdown, no schema abaixo:

{
  "nome": "nome completo do profissional",
  "conselho": "CRP" | "CRM" | "CRESS" | "CREFITO" | "CRFA" | "CRN" | "CRO" | "CREF" | "outro",
  "registro": "número de registro como aparece (ex: '06/12345', '123456-SC', '12345-TO')",
  "regiao": "UF/região do conselho (ex: 'SC', '06', 'CRN-2')",
  "dataInscricao": "data ORIGINAL de inscrição no conselho em formato ISO YYYY-MM-DD, ou null se não conseguir ler",
  "situacao": "status da inscrição (ex: 'ativo', 'regular', 'suspenso', 'cancelado')",
  "tipoDocumento": "carteira" | "sistema-oficial-print" | "declaracao" | "outro",
  "confidence": 0.0 a 1.0,
  "observacoes": "QR code presente, assinatura digital, sinais de adulteração, screenshot zoado, etc"
}

Regras importantes:
1. "dataInscricao" é a data de PRIMEIRA INSCRIÇÃO no conselho (quando o profissional foi habilitado), não a data de validade da carteira nem a data de emissão do documento. Se o doc tem ambas, retorne a de INSCRIÇÃO.
2. ${expectedName ? `Nome esperado: "${expectedName}". Se não bater (case-insensitive, ignore acentos), reduza confidence drasticamente.` : ""}
3. ${expectedConselho ? `Conselho esperado: ${expectedConselho}. Se o documento for de OUTRO conselho, reduza confidence drasticamente — o profissional declarou esse tipo no cadastro.` : ""}
4. ${expectedRegistro ? `Número de registro esperado: "${expectedRegistro}". Se aparecer e não bater (compare apenas dígitos), reduza confidence drasticamente.` : ""}
5. "confidence" reflete autenticidade: prints de sistemas oficiais são mais confiáveis que fotos de carteira (que podem ser editadas). Reduza pra 0.3-0.5 se a foto está estranha (datas com fontes inconsistentes, áreas turvas perto da data, etc).
6. Não invente dados. Se não conseguir ler um campo, retorne null/string vazia.
7. Se o documento não é um registro profissional de nenhum dos conselhos listados (ex: declaração de matrícula, RG, comprovante de pagamento), retorne confidence ≤ 0.2 e conselho="outro".`;
}

function applyRegistrationValidationRules({ extracted, expectedName, expectedConselho, expectedRegistro, llmConfidence }) {
  const reasons = [];
  let confidence = clamp01(Number(llmConfidence) || 0);

  if (!extracted.dataInscricao) {
    reasons.push("data de inscrição no conselho não identificada");
    return { decision: "manual-review", confidence: Math.min(confidence, 0.5), reasons };
  }

  if (extracted.situacao && /suspenso|cancelado|inativo|baixa/i.test(extracted.situacao)) {
    reasons.push(`registro em situação "${extracted.situacao}" — inelegível`);
    return { decision: "rejected", confidence: 0, reasons };
  }

  // Cálculo da janela: inscrição até 12 meses atrás (com tolerância de 7 dias)
  const months = monthsSince(extracted.dataInscricao);
  if (months === null) {
    reasons.push("data de inscrição em formato inválido");
    confidence = Math.min(confidence, 0.4);
  } else if (months < 0) {
    reasons.push("data de inscrição no futuro — suspeito");
    return { decision: "rejected", confidence: 0, reasons };
  } else if (months > RECEM_FORMADO_MAX_MONTHS) {
    reasons.push(`inscrição há ${months} meses — fora da janela de 12 meses do tier recém-formado`);
    return { decision: "rejected", confidence: 0, reasons };
  }

  if (expectedName && extracted.nome) {
    if (!fuzzyNameMatch(expectedName, extracted.nome)) {
      reasons.push(`nome no documento ("${extracted.nome}") não bate com cadastro ("${expectedName}")`);
      return { decision: "rejected", confidence: 0, reasons };
    }
  }

  // Conselho declarado no cadastro precisa bater com o do documento.
  // Se o LLM não conseguiu identificar (conselho="outro"), deixa passar
  // pra revisão manual em vez de rejeitar — pode ser carteira atípica.
  if (expectedConselho && extracted.conselho && extracted.conselho !== "outro") {
    if (extracted.conselho !== expectedConselho) {
      reasons.push(`documento é de ${extracted.conselho}, mas o cadastro informou ${expectedConselho}`);
      return { decision: "rejected", confidence: 0, reasons };
    }
  }

  if (expectedRegistro && extracted.registro) {
    if (!fuzzyRegistroMatch(expectedRegistro, extracted.registro)) {
      reasons.push(`registro no documento (${extracted.registro}) não bate com cadastro (${expectedRegistro})`);
      return { decision: "rejected", confidence: 0, reasons };
    }
  }

  let decision;
  if (confidence >= AUTO_APPROVE_CONFIDENCE && reasons.length === 0) {
    decision = "approved";
    reasons.push(`aprovado: inscrição há ${months} meses (dentro da janela de 12 meses)`);
  } else if (confidence < REJECT_CONFIDENCE) {
    decision = "rejected";
    reasons.unshift("confiança muito baixa para considerar este documento autêntico");
  } else {
    decision = "manual-review";
    reasons.unshift("confiança intermediária — admin revisa antes de liberar");
  }

  return { decision, confidence, reasons };
}

function normalizeRegistrationExtracted(raw) {
  // Compat com prompts antigos que usavam CFP/CFM como sigla. Mapeia pra CRP/CRM.
  const rawConselho = String(raw.conselho || "").toUpperCase();
  const mapped = rawConselho === "CFP" ? "CRP"
              : rawConselho === "CFM" ? "CRM"
              : rawConselho;
  const conselho = isValidSigla(mapped) ? normalizeSigla(mapped) : "outro";
  const dataInscricao = parseIsoDate(raw.dataInscricao);
  return {
    nome: String(raw.nome || "").trim(),
    conselho,
    registro: String(raw.registro || "").trim(),
    regiao: String(raw.regiao || "").trim(),
    dataInscricao,
    monthsSinceInscricao: dataInscricao ? monthsSince(dataInscricao) : null,
    situacao: String(raw.situacao || "").trim(),
    tipoDocumento: String(raw.tipoDocumento || "outro").trim().toLowerCase(),
    observacoes: String(raw.observacoes || "").trim().slice(0, 500)
  };
}

function emptyRegistrationExtracted() {
  return {
    nome: "", conselho: "outro", registro: "", regiao: "",
    dataInscricao: null, monthsSinceInscricao: null,
    situacao: "", tipoDocumento: "outro", observacoes: ""
  };
}

// Match aproximado de número de registro: ignora formatação (barras, hifens,
// espaços) e UF. "06/12345" matches "12345-RS" matches "12345/06".
function fuzzyRegistroMatch(expected, found) {
  const digits = (s) => String(s).replace(/[^0-9]/g, "");
  const e = digits(expected);
  const f = digits(found);
  if (!e || !f) return false;
  // O número principal tem 5+ dígitos. Compara o último bloco contínuo de 5+ dígitos.
  return e.includes(f) || f.includes(e);
}

function monthsSince(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}

function rejected({ reason, provider }) {
  return {
    ok: false,
    decision: "rejected",
    confidence: 0,
    reasons: [reason],
    extracted: emptyExtracted(),
    provider
  };
}

function isImageOrPdf(mediaType) {
  return ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(mediaType);
}

function clamp01(n) {
  if (typeof n !== "number" || isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function parseIsoDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

// Match aproximado de nomes: ignora caso, acentos, ordem das palavras.
// Aceita se >= 70% das palavras significativas (>2 chars) do esperado aparecem no encontrado.
function fuzzyNameMatch(expected, found) {
  const norm = (s) => String(s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);
  const exp = new Set(norm(expected));
  const fnd = new Set(norm(found));
  if (exp.size === 0) return false;
  let hits = 0;
  for (const w of exp) if (fnd.has(w)) hits++;
  return (hits / exp.size) >= 0.7;
}

function getValidator() {
  const provider = String(process.env.DOC_VALIDATOR_PROVIDER || "claude").toLowerCase();
  if (provider === "claude" && ANTHROPIC_API_KEY) {
    return new ClaudeVisionValidator(ANTHROPIC_API_KEY);
  }
  return new MockValidator();
}

module.exports = {
  getValidator,
  ClaudeVisionValidator,
  MockValidator,
  AUTO_APPROVE_CONFIDENCE,
  REJECT_CONFIDENCE,
  DOC_VALIDITY_DAYS,
  CURSOS_ELEGIVEIS,
  RECEM_FORMADO_MAX_MONTHS
};
