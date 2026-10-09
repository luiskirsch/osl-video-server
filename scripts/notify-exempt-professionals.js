// Comunicado aos profissionais isentos (legacyExempt) sobre a mensalidade.
//   railway run node scripts/notify-exempt-professionals.js
"use strict";
const admin = require("firebase-admin");
const { getDb } = require("../services/firestore");
const { sendEmail } = require("../services/email");
const esc = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
(async () => {
  const db = getDb();
  const snap = await db.collection("therapists").where("legacyExempt", "==", true).get();
  let sent = 0, skipped = 0, errors = 0;
  for (const d of snap.docs) {
    const t = d.data();
    if (t.exemptNoticeSentAt) { skipped++; continue; }
    let email = t.email;
    if (!email) { try { email = (await admin.auth().getUser(d.id)).email; } catch {} }
    if (!email) { skipped++; continue; }
    const first = String(t.displayName || "").trim().split(/\s+/)[0] || "";
    const nome = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "";
    const subject = "Você está isento da mensalidade do Espaço Prelúdio";
    const text = `Olá${nome ? ", " + nome : ""}!\n\nAtualizamos o sistema de assinaturas do Espaço Prelúdio. Como profissional já cadastrado, você está isento da mensalidade: seu acesso continua completo, sem nenhuma cobrança.\n\nSe recebeu um e-mail do Mercado Pago sobre a assinatura, pode desconsiderar.\n\nQualquer dúvida, estamos à disposição: contato@espacopreludio.com.br\n\nEquipe Espaço Prelúdio`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c1f1d;max-width:560px">
<p>Olá${nome ? ", " + esc(nome) : ""}!</p>
<p>Atualizamos o sistema de assinaturas do Espaço Prelúdio. Como profissional já cadastrado, <strong>você está isento da mensalidade</strong>: seu acesso continua completo, sem nenhuma cobrança.</p>
<p>Se recebeu um e-mail do Mercado Pago sobre a assinatura, pode desconsiderar.</p>
<p>Qualquer dúvida, estamos à disposição: <a href="mailto:contato@espacopreludio.com.br">contato@espacopreludio.com.br</a></p>
<p>Equipe Espaço Prelúdio</p></div>`;
    try {
      const r = await sendEmail({ to: email, subject, html, text });
      if (r && (r.ok || r.skipped)) { sent++; await d.ref.set({ exemptNoticeSentAt: Date.now() }, { merge: true }); }
      else { errors++; console.log("  ! falhou:", d.id, r && r.error); }
    } catch (e) { errors++; console.log("  ! erro:", d.id, e.message); }
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(JSON.stringify({ enviados: sent, pulados: skipped, erros: errors }));
  process.exit(0);
})();
