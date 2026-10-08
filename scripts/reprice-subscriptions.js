// Reajusta assinaturas ativas do plano profissional para o preço atual
// (THERAPY_PLAN_PROFISSIONAL_AMOUNT / _ANNUAL_AMOUNT) no Mercado Pago.
//
// Uso (credenciais de produção):
//   railway run node scripts/reprice-subscriptions.js            → simulação
//   railway run node scripts/reprice-subscriptions.js --apply    → aplica
//
// Só reduz valor (nunca aumenta) e só mexe em preapprovals ativos.
"use strict";

const { getDb } = require("../services/firestore");
const {
  MP_ACCESS_TOKEN_THERAPY,
  THERAPY_PLAN_PROFISSIONAL_AMOUNT,
  THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT
} = require("../config");

const APPLY = process.argv.includes("--apply");
const ACTIVE = new Set(["authorized", "pending"]);

async function mp(path, init = {}) {
  const r = await fetch(`https://api.mercadopago.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_THERAPY}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`MP ${r.status}: ${body.message || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main() {
  if (!MP_ACCESS_TOKEN_THERAPY) throw new Error("MP_ACCESS_TOKEN_THERAPY ausente");
  const db = getDb();
  if (!db) throw new Error("Firestore indisponível");
  const snap = await db.collection("therapists").where("mpPreapprovalId", "!=", null).get();
  const summary = { checked: 0, toChange: 0, changed: 0, skipped: 0, errors: 0 };
  for (const doc of snap.docs) {
    const t = doc.data();
    summary.checked++;
    try {
      const pre = await mp(`/preapproval/${encodeURIComponent(t.mpPreapprovalId)}`);
      const current = Number(pre?.auto_recurring?.transaction_amount);
      const yearly = (Number(pre?.auto_recurring?.frequency) || 1) >= 12;
      const target = yearly ? THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT : THERAPY_PLAN_PROFISSIONAL_AMOUNT;
      const line = `${doc.id} · ${t.displayName || "-"} · ${pre.status} · ${yearly ? "anual" : "mensal"} · R$ ${current} → R$ ${target}`;
      if (!ACTIVE.has(pre.status) || !(current > target + 0.004)) {
        summary.skipped++;
        console.log(`  =  ${line} (sem mudança)`);
        continue;
      }
      summary.toChange++;
      if (!APPLY) { console.log(`  ~  ${line}`); continue; }
      await mp(`/preapproval/${encodeURIComponent(t.mpPreapprovalId)}`, {
        method: "PUT",
        body: JSON.stringify({ auto_recurring: { transaction_amount: target, currency_id: "BRL" } })
      });
      await doc.ref.set({ proPriceCents: Math.round(target * 100), repricedAt: Date.now(), repricedFrom: current }, { merge: true });
      summary.changed++;
      console.log(`  ✓  ${line}`);
    } catch (e) {
      summary.errors++;
      console.log(`  !  ${doc.id} · ${e.message}`);
    }
  }
  console.log(APPLY ? "APLICADO" : "SIMULAÇÃO (use --apply para aplicar)", summary);
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
