// NEXUS — núcleo de segurança: criptografia, 2FA (TOTP), limites de requisição, CSRF, cabeçalhos e auditoria.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PROD = process.env.NODE_ENV === 'production';

// ============================================================ chave mestra (criptografia em repouso)
function masterKey(dataDir) {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
let KEY = null;
function initKey(dataDir) { KEY = masterKey(dataDir); }

// AES-256-GCM: formato "v1:iv:tag:dados" (base64url)
function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}
function decrypt(blob) {
  if (!blob) return '';
  if (!blob.startsWith('v1:')) return blob; // valor legado em texto
  const [, iv, tag, data] = blob.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, msg, alg = 'sha256') => crypto.createHmac(alg, key).update(msg).digest('hex');
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
const mask = (s, keep = 4) => !s ? '' : s.length <= keep ? '•'.repeat(s.length) : '•'.repeat(Math.min(16, s.length - keep)) + s.slice(-keep);

// ============================================================ senhas (scrypt reforçado)
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `s2$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  if (stored.startsWith('s2$')) {
    const [, salt, h] = stored.split('$');
    const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32, SCRYPT);
    return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
  }
  const [salt, h] = stored.split(':'); // formato antigo
  if (!salt || !h) return false;
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
}
const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'senha123', 'senha1234', 'qwerty123', '11111111', '00000000', 'abc12345', 'admin123', 'iloveyou', 'password1', '12341234', 'mudar123']);
function passwordProblem(pw, { min = 8, email = '', username = '' } = {}) {
  if (typeof pw !== 'string' || pw.length < min) return `A senha precisa de pelo menos ${min} caracteres`;
  if (pw.length > 200) return 'Senha longa demais';
  if (COMMON.has(pw.toLowerCase())) return 'Essa senha é muito comum. Escolha outra.';
  if ((email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) || (username && username.length > 2 && pw.toLowerCase().includes(username.toLowerCase())))
    return 'A senha não pode conter seu usuário ou e-mail';
  if (min >= 10 && !(/[a-zA-Z]/.test(pw) && /\d/.test(pw))) return 'Use letras e números na senha';
  return null;
}

// ============================================================ TOTP (RFC 6238) — 2 fatores
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newTotpSecret = () => base32(crypto.randomBytes(20));
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
// retorna o contador aceito; -1 = código errado; -2 = código certo, mas já usado (anti-reuso)
function verifyTotp(secret, code, lastCounter = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return -1;
  const now = Math.floor(Date.now() / 30000);
  let reused = false;
  for (const c of [now, now - 1, now + 1]) {
    if (!safeEqual(totpAt(secret, c), code)) continue;
    if (c <= lastCounter) { reused = true; continue; }
    return c;
  }
  return reused ? -2 : -1;
}
const totpError = c => c === -2
  ? 'Esse código já foi usado. Espere o app mostrar o próximo (até 30 s) e digite o novo.'
  : 'Código incorreto. Confira se a data e hora do celular estão automáticas.';
const otpauthUri = (secret, account, issuer = 'NEXUS') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
function recoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const s = crypto.randomBytes(6).toString('hex').toUpperCase();
    return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
  });
}

// ============================================================ IP do cliente
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
const isHttps = req => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

// ============================================================ limitador (token bucket) + bloqueio automático
const RULES = {
  auth: { cap: 8, perMin: 4 },       // login, cadastro, 2FA
  sensitive: { cap: 10, perMin: 6 }, // checkout, confirmações
  api: { cap: 240, perMin: 240 },    // API dos jogos (por chave)
  admin: { cap: 300, perMin: 300 },
  public: { cap: 120, perMin: 120 },
  webhook: { cap: 120, perMin: 120 },
};
const buckets = new Map();
const violations = new Map();
const blocked = new Map(); // ip → até quando
let onBlock = () => { };
function setOnBlock(fn) { onBlock = fn; }

function isBlocked(ip) {
  const until = blocked.get(ip);
  if (!until) return false;
  if (Date.now() > until) { blocked.delete(ip); return false; }
  return true;
}
function take(kind, key, ip) {
  const rule = RULES[kind];
  const k = kind + '|' + key;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b) { b = { t: rule.cap, at: now }; buckets.set(k, b); }
  b.t = Math.min(rule.cap, b.t + ((now - b.at) / 60000) * rule.perMin);
  b.at = now;
  if (b.t < 1) {
    const v = (violations.get(ip) || 0) + 1;
    violations.set(ip, v);
    if (v >= 25) { blocked.set(ip, now + 15 * 60000); violations.delete(ip); onBlock(ip, kind); }
    return Math.ceil(((1 - b.t) / rule.perMin) * 60);
  }
  b.t -= 1;
  return 0;
}
function blockIp(ip, minutes = 15) { blocked.set(ip, Date.now() + minutes * 60000); }
function blockedList() { return [...blocked.entries()].filter(([, u]) => u > Date.now()).map(([ip, until]) => ({ ip, until: new Date(until).toISOString() })); }
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.at > 10 * 60000) buckets.delete(k);
  violations.clear();
}, 10 * 60000).unref();

// ============================================================ CSRF: origem + cabeçalho obrigatório
function sameOrigin(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false;
  try { return new URL(src).host === host; } catch { return false; }
}
function csrfOk(req) {
  return req.headers['x-requested-with'] === 'nexus' && sameOrigin(req);
}

// ============================================================ cabeçalhos de segurança
function securityHeaders(req, res, { api = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups'); // necessário para o login do Google em pop-up
  res.setHeader('Cross-Origin-Resource-Policy', api ? 'cross-origin' : 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  if (!api) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://apis.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
      `frame-src https://${require('./config').firebase.authDomain} https://accounts.google.com`,
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      ...(isHttps(req) ? ['upgrade-insecure-requests'] : []),
    ].join('; '));
  }
}

// ============================================================ assinatura de requisições dos jogos (HMAC + anti-replay)
const seenSigs = new Map();
setInterval(() => { const t = Date.now(); for (const [s, at] of seenSigs) if (t - at > 10 * 60000) seenSigs.delete(s); }, 60000).unref();
function verifyGameSignature(req, rawBody, secret) {
  const ts = Number(req.headers['x-nexus-timestamp']);
  const sig = String(req.headers['x-nexus-signature'] || '');
  if (!ts || !sig) return 'Assinatura ausente';
  if (Math.abs(Date.now() / 1000 - ts) > 300) return 'Timestamp fora da janela de 5 minutos';
  const url = new URL(req.url, 'http://x');
  const expected = hmac(secret, `${ts}.${req.method}.${url.pathname}${url.search}.${rawBody || ''}`);
  if (!safeEqual(expected, sig)) return 'Assinatura inválida';
  if (seenSigs.has(sig)) return 'Requisição repetida (replay)';
  seenSigs.set(sig, Date.now());
  return null;
}

module.exports = {
  PROD, initKey, encrypt, decrypt, sha256, hmac, safeEqual, mask,
  hashPassword, checkPassword, passwordProblem,
  newTotpSecret, verifyTotp, totpError, otpauthUri, recoveryCodes, totpAt,
  clientIp, isHttps, take, isBlocked, blockIp, blockedList, setOnBlock,
  csrfOk, securityHeaders, verifyGameSignature,
};
