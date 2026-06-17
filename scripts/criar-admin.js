#!/usr/bin/env node
// Cria (ou atualiza a senha de) contato@espacopreludio.com.br no Firebase Auth.
// Uso: node scripts/criar-admin.js <senha>
// Exemplo: node scripts/criar-admin.js MinhaS3nh@Segura123

require('dotenv').config();
const admin = require('firebase-admin');

const ADMIN_EMAIL = 'contato@espacopreludio.com.br';

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌  FIREBASE_SERVICE_ACCOUNT_JSON não encontrado no .env');
  process.exit(1);
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}

async function run() {
  const password = process.argv[2];
  if (!password || password.length < 10) {
    console.error('❌  Informe uma senha (mín. 10 caracteres) como argumento.');
    console.error('    node scripts/criar-admin.js MinhaS3nh@123');
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
