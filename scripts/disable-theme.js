// One-off: desativa o tema sazonal ativo no Firestore prod (osextolugar-game).
// Seta config/activeTheme.themeId = "default" + clears activeUntil/From.
require('dotenv').config();
const admin = require('firebase-admin');
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
(async () => {
  const ref = db.collection('config').doc('activeTheme');
  const before = await ref.get();
  console.log('BEFORE:', before.exists ? JSON.stringify(before.data(), null, 2) : '(doc inexistente)');
  await ref.set({
    themeId: 'default',
    activeFrom: null,
    activeUntil: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'cli-disable-2026-05-23'
  }, { merge: true });
  const after = await ref.get();
  console.log('AFTER:', JSON.stringify(after.data(), null, 2));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
