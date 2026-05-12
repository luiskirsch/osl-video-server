// services/clinic.js
//
// Clínica multidisciplinar: dono (também profissional) tem N membros
// (outros profissionais). Cada membro tem regra de repasse (% sobre
// receita OU valor fixo por consulta).
//
// Coleções Firestore:
//   therapy_clinics/{clinicId}
//     - clinicId, ownerUid, name, cnpj?, createdAt, updatedAt
//
//   therapy_clinic_members/{memberId}
//     - memberId, clinicId
//     - invitedEmail (lowercase) — fonte primária do convite
//     - therapistUid (null até o convidado aceitar)
//     - status: "pending" | "active" | "removed"
//     - repasseRule: { type: "percentual"|"valor-fixo", value: number }
//         percentual: 0–100 (ex.: 70 = 70%)
//         valor-fixo: integer em centavos (ex.: 15000 = R$ 150 por consulta)
//     - invitedByUid, invitedAt, acceptedAt?, removedAt?
//
// Quem pode atender (performedByUid em therapy_transactions):
//   - O próprio dono (ownerUid)
//   - Qualquer membro com status="active"
//
// Cálculo de repasse mensal:
//   - Para cada membro ativo, pega transações do mês com performedByUid=member
//   - Soma receita
//   - Aplica regra: percentual = totalReceita × (value/100)
//                   valor-fixo = countSessoes × value
//
// Regra "1 dono = 1 clínica": cada user pode ter no máximo 1 clínica como
// dono (limita complexidade de UI). Pode ser membro de várias.

const REPASSE_TYPES = new Set(["percentual", "valor-fixo"]);
const MEMBER_STATUS = new Set(["pending", "active", "removed"]);

// Limites sanitários.
const NAME_MAX            = 100;
const CNPJ_MAX            = 18;          // formato 00.000.000/0001-00
const PERCENTUAL_MIN      = 0;
const PERCENTUAL_MAX      = 100;
const VALOR_FIXO_MIN_CENTS = 1;
const VALOR_FIXO_MAX_CENTS = 1_000_000_00; // R$ 1 milhão (sanity)

function isValidRepasseRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (!REPASSE_TYPES.has(rule.type)) return false;
  const v = Number(rule.value);
  if (!Number.isFinite(v)) return false;
  if (rule.type === "percentual") {
    if (v < PERCENTUAL_MIN || v > PERCENTUAL_MAX) return false;
  } else {
    // valor-fixo: integer em centavos
    if (!Number.isInteger(v)) return false;
    if (v < VALOR_FIXO_MIN_CENTS || v > VALOR_FIXO_MAX_CENTS) return false;
  }
  return true;
}

// Normaliza email pra lowercase + trim. Não valida formato profundamente —
// validação é responsabilidade do form/Firebase Auth.
function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function isValidEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  // Sanity check leve. Real validation no Firebase Auth.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Calcula repasse de UMA transação pra UM membro (já filtrada pelo caller).
// amount em centavos. Retorna integer em centavos.
function computeRepasseForTransaction(rule, transactionAmountCents) {
  if (!isValidRepasseRule(rule)) return 0;
  if (rule.type === "percentual") {
    // Math.round pra evitar centavo fracionado.
    return Math.round(transactionAmountCents * (rule.value / 100));
  }
  // valor-fixo: cada transação rende o valor fixo, independente do amount.
  return rule.value;
}

// Agrega repasse de uma lista de transações pra cada membro. Retorna
// shape estável pro frontend.
//
// Args:
//   members: [{ memberId, therapistUid, name?, repasseRule, status }]
//   transactions: [{ performedByUid, amount, type, status }]
//
// Apenas transações com type="receita", status="pago", performedByUid
// definido entram no cálculo.
function computeMonthlyRepasse(members, transactions) {
  const byMember = new Map();
  for (const m of members) {
    if (m.status !== "active" || !m.therapistUid) continue;
    byMember.set(m.therapistUid, {
      memberId: m.memberId,
      therapistUid: m.therapistUid,
      name: m.name || null,
      invitedEmail: m.invitedEmail || null,
      repasseRule: m.repasseRule,
      totalConsultasCents: 0,
      countConsultas: 0,
      totalRepasseCents: 0
    });
  }
  for (const tx of transactions || []) {
    if (tx.type !== "receita") continue;
    if (tx.status !== "pago") continue;
    if (!tx.performedByUid) continue;
    const entry = byMember.get(tx.performedByUid);
    if (!entry) continue; // não é membro ativo (talvez ex-membro)
    entry.totalConsultasCents += tx.amount || 0;
    entry.countConsultas += 1;
    entry.totalRepasseCents += computeRepasseForTransaction(entry.repasseRule, tx.amount || 0);
  }
  return [...byMember.values()].sort((a, b) =>
    (a.name || a.invitedEmail || "").localeCompare(b.name || b.invitedEmail || "", "pt-BR")
  );
}

module.exports = {
  REPASSE_TYPES,
  MEMBER_STATUS,
  NAME_MAX,
  CNPJ_MAX,
  PERCENTUAL_MIN,
  PERCENTUAL_MAX,
  VALOR_FIXO_MIN_CENTS,
  VALOR_FIXO_MAX_CENTS,
  isValidRepasseRule,
  isValidEmail,
  normalizeEmail,
  computeRepasseForTransaction,
  computeMonthlyRepasse
};
