// services/financial.js
//
// Controle financeiro do profissional — receitas e despesas categorizadas
// com vínculo opcional a paciente/sessão. Suporta 3 status (pendente/pago/
// cancelado) pra controle de contas a receber/pagar.
//
// Coleção Firestore: therapy_transactions/{txId}
//
// Modelo de dado:
//   txId, therapistUid (sempre)
//   type            "receita" | "despesa"
//   category        string (ver CATEGORIES — receita ou despesa)
//   amount          integer (centavos)
//   description     string (até 200 chars, opcional)
//   paymentMethod   "pix" | "dinheiro" | "cartao-credito" | "cartao-debito"
//                   | "transferencia" | "boleto" | "outro"
//   status          "pendente" | "pago" | "cancelado"
//   patientId       string | null   (opcional, link com paciente cadastrado)
//   patientNameSnapshot string | null  (snapshot pra mostrar mesmo se paciente apagado)
//   sessionId       string | null   (opcional, link com sessão)
//   issueDate       timestamp       (competência — quando a operação ocorreu)
//   dueDate         timestamp | null (vencimento — pra pendentes)
//   paidDate        timestamp | null (quando efetivado)
//   createdAt, updatedAt
//
// Privacidade: amount/category/method/status ficam plaintext (necessário pra
// agrupamento server-side em /resumo). description é texto livre opcional —
// recomendar ao user não pôr dado clínico ali (apenas tags tipo "Sessão 15/05").
// patientNameSnapshot é o display name do paciente NO MOMENTO da transação,
// gravado pra que o relatório histórico continue legível mesmo se o paciente
// for deletado ou seu nome mudar.

// Categorias suportadas. Cada uma é exclusiva de tipo (receita ou despesa).
// Lista fechada por enquanto — categorias customizáveis pelo usuário ficam
// pra v2 (precisaria de doc therapy_categories/{uid}).
const RECEITA_CATEGORIES = [
  "consulta",        // sessão de atendimento (vínculo paciente recomendado)
  "supervisao",      // supervisão prestada a outros profissionais
  "palestra",        // palestra, curso, workshop
  "convenio",        // recebimento de operadora de saúde (TISS futuro)
  "outros-receita"
];

const DESPESA_CATEGORIES = [
  "aluguel",         // sala/consultório
  "marketing",       // anúncios, divulgação
  "material",        // suprimentos clínicos, papelaria
  "imposto",         // ISS, INSS, IR, DAS
  "software",        // assinaturas (incluindo Prelúdio)
  "supervisao-recebida", // supervisão que VOCÊ paga a um supervisor
  "formacao",        // cursos, congressos, livros
  "transporte",      // deslocamento profissional
  "outros-despesa"
];

const ALL_CATEGORIES = new Set([...RECEITA_CATEGORIES, ...DESPESA_CATEGORIES]);

// Mapping pro frontend agrupar dropdowns + labels human-readable.
const CATEGORY_LABELS = {
  "consulta":            { label: "Consulta", type: "receita" },
  "supervisao":          { label: "Supervisão prestada", type: "receita" },
  "palestra":            { label: "Palestra / curso", type: "receita" },
  "convenio":            { label: "Convênio / operadora", type: "receita" },
  "outros-receita":      { label: "Outras receitas", type: "receita" },
  "aluguel":             { label: "Aluguel", type: "despesa" },
  "marketing":           { label: "Marketing", type: "despesa" },
  "material":            { label: "Material / suprimentos", type: "despesa" },
  "imposto":             { label: "Impostos", type: "despesa" },
  "software":            { label: "Software / assinaturas", type: "despesa" },
  "supervisao-recebida": { label: "Supervisão (paga)", type: "despesa" },
  "formacao":            { label: "Formação / cursos", type: "despesa" },
  "transporte":          { label: "Transporte", type: "despesa" },
  "outros-despesa":      { label: "Outras despesas", type: "despesa" }
};

const VALID_TYPES = new Set(["receita", "despesa"]);
const VALID_STATUS = new Set(["pendente", "pago", "cancelado"]);
const VALID_PAYMENT_METHODS = new Set([
  "pix", "dinheiro", "cartao-credito", "cartao-debito",
  "transferencia", "boleto", "outro"
]);

// Limites de input pra evitar abuso de storage.
const DESCRIPTION_MAX = 200;
const AMOUNT_MIN_CENTS = 1;          // 1 centavo
const AMOUNT_MAX_CENTS = 1_000_000_00; // R$ 1 milhão (sanity check)

function isValidType(t) { return VALID_TYPES.has(t); }
function isValidStatus(s) { return VALID_STATUS.has(s); }
function isValidPaymentMethod(m) { return VALID_PAYMENT_METHODS.has(m); }
function isValidCategory(c) { return ALL_CATEGORIES.has(c); }

// Garante que category combine com type — não dá pra ter type=despesa,
// category=consulta. Retorna { ok: boolean, reason: string }.
function validateCategoryForType(type, category) {
  if (!isValidType(type)) return { ok: false, reason: "TIPO_INVALIDO" };
  if (!isValidCategory(category)) return { ok: false, reason: "CATEGORIA_INVALIDA" };
  if (CATEGORY_LABELS[category].type !== type) {
    return { ok: false, reason: "CATEGORIA_INCOMPATIVEL_COM_TIPO" };
  }
  return { ok: true };
}

// Valida amount em centavos. Aceita integer positivo dentro dos limites.
function isValidAmount(cents) {
  if (typeof cents !== "number") return false;
  if (!Number.isInteger(cents)) return false;
  if (cents < AMOUNT_MIN_CENTS || cents > AMOUNT_MAX_CENTS) return false;
  return true;
}

// Calcula resumo financeiro a partir de uma lista de transações. Usado pelo
// endpoint /resumo pra mostrar dashboard mensal: totais por tipo+status, top
// categorias. Tudo em centavos (frontend formata pra R$).
//
// Retorna shape estável mesmo com lista vazia — frontend não precisa
// branching defensivo.
function computeSummary(transactions) {
  const summary = {
    receitas: {
      pago:      { count: 0, totalCents: 0 },
      pendente:  { count: 0, totalCents: 0 },
      cancelado: { count: 0, totalCents: 0 }
    },
    despesas: {
      pago:      { count: 0, totalCents: 0 },
      pendente:  { count: 0, totalCents: 0 },
      cancelado: { count: 0, totalCents: 0 }
    },
    // Saldo do mês = receitas pagas - despesas pagas.
    saldoCents: 0,
    // Previsto = receitas (pagas+pendentes) - despesas (pagas+pendentes).
    // Útil pra projeção de caixa se tudo for pago/recebido conforme planejado.
    previstoCents: 0,
    // Top 5 categorias por valor pago (mais um pro relatório do dashboard).
    topCategoriasReceita: [],
    topCategoriasDespesa: []
  };

  const catReceitaMap = new Map(); // category -> totalCents (pagas)
  const catDespesaMap = new Map();

  for (const tx of transactions || []) {
    const bucket = tx.type === "receita" ? summary.receitas
                 : tx.type === "despesa" ? summary.despesas
                 : null;
    if (!bucket) continue;
    const slot = bucket[tx.status];
    if (!slot) continue;
    slot.count += 1;
    slot.totalCents += tx.amount || 0;
    if (tx.status === "pago") {
      const m = tx.type === "receita" ? catReceitaMap : catDespesaMap;
      m.set(tx.category, (m.get(tx.category) || 0) + (tx.amount || 0));
    }
  }

  summary.saldoCents =
    summary.receitas.pago.totalCents - summary.despesas.pago.totalCents;
  summary.previstoCents =
    (summary.receitas.pago.totalCents + summary.receitas.pendente.totalCents) -
    (summary.despesas.pago.totalCents + summary.despesas.pendente.totalCents);

  const toSortedTop = (map) =>
    [...map.entries()]
      .map(([category, totalCents]) => ({
        category, totalCents,
        label: CATEGORY_LABELS[category]?.label || category
      }))
      .sort((a, b) => b.totalCents - a.totalCents)
      .slice(0, 5);

  summary.topCategoriasReceita = toSortedTop(catReceitaMap);
  summary.topCategoriasDespesa = toSortedTop(catDespesaMap);
  return summary;
}

// Calcula range de timestamps pra um mês YYYY-MM. Inclusive no início,
// exclusive no fim — facilita queries com >= startMs E < endMs.
// Retorna null se input inválido.
function parseMonthRange(monthStr) {
  if (typeof monthStr !== "string") return null;
  const m = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (year < 2020 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  const startMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const endMs   = Date.UTC(year, month, 1, 0, 0, 0, 0); // 1º dia do mês seguinte
  return { startMs, endMs };
}

module.exports = {
  RECEITA_CATEGORIES,
  DESPESA_CATEGORIES,
  CATEGORY_LABELS,
  VALID_TYPES,
  VALID_STATUS,
  VALID_PAYMENT_METHODS,
  DESCRIPTION_MAX,
  AMOUNT_MIN_CENTS,
  AMOUNT_MAX_CENTS,
  isValidType,
  isValidStatus,
  isValidPaymentMethod,
  isValidCategory,
  validateCategoryForType,
  isValidAmount,
  computeSummary,
  parseMonthRange
};
