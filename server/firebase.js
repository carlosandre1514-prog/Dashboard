// Verificação de ID tokens do Firebase Authentication sem SDK: confere a assinatura RS256 com os
// certificados públicos do Google e valida emissor, público, validade e horário do login.
'use strict';
const crypto = require('node:crypto');
const { firebase } = require('./config');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cache = { certs: null, until: 0 };

async function certs() {
  if (cache.certs && Date.now() < cache.until) return cache.certs;
  // somente para testes automatizados locais — ignorado em produção
  if (process.env.FIREBASE_TEST_CERTS && process.env.NODE_ENV !== 'production') {
    cache = { certs: JSON.parse(require('node:fs').readFileSync(process.env.FIREBASE_TEST_CERTS, 'utf8')), until: Date.now() + 60000 };
    return cache.certs;
  }
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Não foi possível obter os certificados do Firebase');
  const maxAge = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  cache = { certs: await r.json(), until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return cache.certs;
}
const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

class AuthError extends Error { constructor(msg) { super(msg); this.status = 401; } }

async function verifyIdToken(token) {
  if (typeof token !== 'string' || token.length > 4096) throw new AuthError('Token ausente');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Token malformado');
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw new AuthError('Token malformado'); }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('Algoritmo de assinatura não aceito');
  let pem = (await certs())[header.kid];
  if (!pem) { cache.until = 0; pem = (await certs())[header.kid]; } // rotação de chaves
  if (!pem) throw new AuthError('Chave de assinatura desconhecida');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify((pem.includes('CERTIFICATE') ? new crypto.X509Certificate(pem).publicKey : crypto.createPublicKey(pem)), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new AuthError('Assinatura do token inválida');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== firebase.projectId) throw new AuthError('Token de outro projeto');
  if (payload.iss !== `https://securetoken.google.com/${firebase.projectId}`) throw new AuthError('Emissor inválido');
  if (!(payload.exp > now)) throw new AuthError('Token expirado');
  if (!(payload.iat <= now + 60)) throw new AuthError('Token emitido no futuro');
  if (!(payload.auth_time <= now + 60)) throw new AuthError('Horário de login inválido');
  if (!payload.sub || payload.sub.length > 128) throw new AuthError('Usuário inválido');
  return {
    uid: payload.sub,
    email: (payload.email || '').toLowerCase(),
    email_verified: payload.email_verified === true,
    name: payload.name || '',
    provider: payload.firebase?.sign_in_provider || '',
    auth_time: payload.auth_time,
  };
}

module.exports = { verifyIdToken, AuthError };
