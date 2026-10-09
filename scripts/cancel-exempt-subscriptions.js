// Cancela no Mercado Pago as assinaturas de profissionais isentos
// (legacyExempt), para que nunca sejam cobrados.
//   railway run node scripts/cancel-exempt-subscriptions.js           → simulação
//   railway run node scripts/cancel-exempt-subscriptions.js --apply   → cancela
"use strict";
const { getDb } = require("../services/firestore");
const { MP_ACCESS_TOKEN_THERAPY } = require("../config");
const APPLY = process.argv.includes("--apply");
const mp = async (path, init = {}) => {
  const r = await fetch(`https://api.mercadopago.com${path}`, { ...init, headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_THERAPY}`, "Content-Type": "application/json" } });
  const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`MP ${r.status}: ${b.message || ""}`); return b;
};
(async () => {
  const snap = await getDb().collection("therapists").where("legacyExempt", "==", true).get();
  const sum = { checked: 0, toCancel: 0, canceled: 0, errors: 0 };
  for (const d of snap.docs) {
    const t = d.data(); if (!t.mpPreapprovalId) continue; sum.checked++;
    try {
      const pre = await mp(`/preapproval/${encodeURIComponent(t.mpPreapprovalId)}`);
      if (!["authorized", "pending", "paused"].includes(pre.status)) continue;
      sum.toCancel++;
      if (!APPLY) { console.log(`  ~ ${t.displayName} (${pre.status})`); continue; }
      await mp(`/preapproval/${encodeURIComponent(t.mpPreapprovalId)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
      await d.ref.set({ mpPreapprovalStatus: "cancelled", exemptSubscriptionCanceledAt: Date.now() }, { merge: true });
      sum.canceled++; console.log(`  ✓ ${t.displayName}`);
    } catch (e) { sum.errors++; console.log(`  ! ${t.displayName}: ${e.message}`); }
  }
  console.log(APPLY ? "APLICADO" : "SIMULAÇÃO (use --apply)", sum); process.exit(0);
})();
