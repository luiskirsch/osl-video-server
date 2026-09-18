#!/usr/bin/env node
// Cria (ou atualiza a senha de) contato@espacopreludio.com.br no Firebase Auth.
// Uso: NEW_ADMIN_PASSWORD=<senha> node scripts/criar-admin.js
// A senha não é aceita como argumento para evitar vazamento no histórico/ps.

require('dotenv').config();
const admin = require('firebase-admin');

const ADMIN_EMAIL = 'contato@espacopreludio.com.br';

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌  FIREBASE_SERVICE_ACCOUNT_JSON não encontrado no .env');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
require('./confirm-firebase-project').assertFirebaseProjectConfirmed(serviceAccount, 'criar-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function run() {
  if (process.argv[2]) {
    console.error('❌  Não passe senha na linha de comando; use NEW_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const password = String(process.env.NEW_ADMIN_PASSWORD || '');
  if (password.length < 12) {
    console.error('❌  Defina NEW_ADMIN_PASSWORD com no mínimo 12 caracteres.');
    process.exit(1);
  }

  try {
    const existing = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    await admin.auth().updateUser(existing.uid, { password, emailVerified: true });
    console.log('✅  Senha atualizada para', ADMIN_EMAIL);
    console.log('    UID:', existing.uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const user = await admin.auth().createUser({
      email:         ADMIN_EMAIL,
      password,
      emailVerified: true,
      displayName:   'Admin — Espaço Prelúdio'
    });
    console.log('✅  Conta criada com sucesso!');
    console.log('    E-mail:', ADMIN_EMAIL);
    console.log('    UID:   ', user.uid);
  }

  console.log('\n⚠️   Certifique-se de que THERAPY_ADMIN_EMAILS no Railway inclui:');
  console.log('     ' + ADMIN_EMAIL);
  process.exit(0);
}

run().catch(err => {
  console.error('❌  Erro:', err.message);
  process.exit(1);
});
