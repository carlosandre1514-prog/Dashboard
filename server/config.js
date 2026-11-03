// Configuração: lê o arquivo .env (se existir) e expõe valores com padrões seguros.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// Configuração web do Firebase (valores públicos por natureza — identificam o projeto, não dão acesso).
// Proteja a chave em Google Cloud → Credenciais → restringir por domínio (HTTP referrer).
const firebase = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyBSCuJpJpMXCJblUaqj8A8BUA54DQ3PCTU',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'dashboard-6fa1e.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'dashboard-6fa1e',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'dashboard-6fa1e.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_SENDER_ID || '374132803441',
  appId: process.env.FIREBASE_APP_ID || '1:374132803441:web:b09e8dde96a7944a0758d0',
};

// E-mails de administrador "donos" (só pelo servidor — ninguém consegue se promover pelo site).
const ownerEmails = () => (process.env.ADMIN_EMAILS || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

module.exports = { firebase, ownerEmails };
