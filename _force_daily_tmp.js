'use strict';
require('dotenv').config();
const { cert, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const svcAcct = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert({ projectId: svcAcct.project_id, clientEmail: svcAcct.client_email, privateKey: svcAcct.private_key }) });
const db = getFirestore();
const { OSL_BASIC_CARDS } = require('./data/cards');

function todayStr() { return new Date().toISOString().slice(0, 10); }
function endOfDayUTC(d) { const x = new Date(d); x.setUTCDate(x.getUTCDate()+1); return x; }

async function main() {
  const today = todayStr();
  console.log('Date UTC:', today, '| Basic cards:', OSL_BASIC_CARDS.length);
  const snap = await db.collection('daily_ritual').doc(today).get();
  if (snap.exists) console.log('Existing:', JSON.stringify({ title: snap.data().cardTitle, text: snap.data().cardText?.slice(0,60), count: snap.data().completionCount }));
  else console.log('No doc for today — will create.');
  const dayNum = new Date(today).getTime();
  const idx = Math.abs(Math.round(dayNum/86400000)) % OSL_BASIC_CARDS.length;
  const card = OSL_BASIC_CARDS[idx];
  console.log(`Card[${idx}]:`, card.title, '|', card.text?.slice(0,80));
  const ritual = {
    date: today, cardTitle: card.title, cardText: card.text||'',
    cardType: card.type||'Ritual', challengeType:'group', bonusXp:50,
    completionCount: snap.exists ? (snap.data().completionCount||0) : 0,
    expiresAt: endOfDayUTC(today),
    createdAt: snap.exists ? snap.data().createdAt : new Date(),
  };
  await db.collection('daily_ritual').doc(today).set(ritual);
  console.log('✓ Written to Firestore.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
