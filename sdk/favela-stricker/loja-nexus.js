// Loja NEXUS ↔ Favela Stricker — módulo para o servidor do jogo (servidor/loja-nexus.js).
//
// O celular NUNCA vê a chave da API do site: ele fala com o servidor do jogo mandando o token de login do
// Firebase do jogo; o servidor confere a assinatura do token (Google) e só então pede ao site as compras
// daquele jogador. Assim ninguém consegue pegar nem "confirmar" a compra de outra pessoa.
//
// Rotas (todas com  Authorization: Bearer <idToken do Firebase do jogo>):
//   POST /api/loja/entrar          registra o jogador no painel + "sessão iniciada"
//   GET  /api/loja/entregas        compras feitas no site, pagas e verificadas, ainda não entregues
//   POST /api/loja/confirmar       {"code":"NX-…"}  depois que o jogo creditou → pedido vira "Entregue"
//   POST /api/loja/evento          {"tipo":"session_start"|"install"}
//
// Variáveis de ambiente no Render do jogo:
//   NEXUS_URL=https://nexus-p70i.onrender.com
//   NEXUS_API_KEY=nx_live_…            (painel → Integração · API)
//   NEXUS_SIGNING_SECRET=nxs_…         (opcional; obrigatório se o painel exigir assinatura)
//   FIREBASE_PROJECT_ID=navegador-f06a8
'use strict';
const crypto = require('crypto');

const SITE = (process.env.NEXUS_URL || 'https://nexus-p70i.onrender.com').replace(/\/$/, '');
const KEY = process.env.NEXUS_API_KEY || '';
const SECRET = process.env.NEXUS_SIGNING_SECRET || '';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'navegador-f06a8';

// ---------------- token do Firebase do jogo (RS256, certificados públicos do Google) ----------------
let certs = { dados: null, ate: 0 };
async function certificados() {
  if (certs.dados && Date.now() < certs.ate) return certs.dados;
  if (process.env.LOJA_TEST_CERTS && process.env.NODE_ENV !== 'production') return (certs = { dados: JSON.parse(require('fs').readFileSync(process.env.LOJA_TEST_CERTS, 'utf8')), ate: Date.now() + 60000 }).dados;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', { signal: AbortSignal.timeout(10000) });
  const idade = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  return (certs = { dados: await r.json(), ate: Date.now() + Math.min(idade, 21600) * 1000 }).dados;
}
async function conferirLogin(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = tok.split('.');
  if (p.length !== 3 || tok.length > 4096) return null;
  try {
    const cab = JSON.parse(Buffer.from(p[0], 'base64url'));
    const dado = JSON.parse(Buffer.from(p[1], 'base64url'));
    if (cab.alg !== 'RS256') return null;
    const pem = (await certificados())[cab.kid];
    if (!pem) return null;
    const chave = pem.includes('CERTIFICATE') ? new crypto.X509Certificate(pem).publicKey : crypto.createPublicKey(pem);
    if (!crypto.createVerify('RSA-SHA256').update(p[0] + '.' + p[1]).verify(chave, Buffer.from(p[2], 'base64url'))) return null;
    const agora = Math.floor(Date.now() / 1000);
    if (dado.aud !== PROJECT || dado.iss !== 'https://securetoken.google.com/' + PROJECT || !(dado.exp > agora) || !dado.sub) return null;
    return { uid: dado.sub, nome: dado.name || (dado.email || '').split('@')[0] || '', convidado: dado.firebase?.sign_in_provider === 'anonymous' };
  } catch { return null; }
}

// ---------------- chamadas ao site NEXUS ----------------
async function nexus(metodo, caminho, corpo) {
  const cheio = '/api/v1' + caminho;
  const json = corpo ? JSON.stringify(corpo) : '';
  const cab = { Authorization: 'Bearer ' + KEY };
  if (corpo) cab['Content-Type'] = 'application/json';
  if (SECRET) {
    const ts = String(Math.floor(Date.now() / 1000));
    cab['X-Nexus-Timestamp'] = ts;
    cab['X-Nexus-Signature'] = crypto.createHmac('sha256', SECRET).update(`${ts}.${metodo}.${cheio}.${json}`).digest('hex');
  }
  // o site gratuito pode estar "acordando": espera até 60 s
  const r = await fetch(SITE + cheio, { method: metodo, headers: cab, body: corpo ? json : undefined, signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'site ' + r.status), { status: r.status });
  return d;
}

// ---------------- limite simples por jogador ----------------
const usos = new Map();
function limite(chave, porMinuto = 20) {
  const agora = Date.now(), u = usos.get(chave) || { n: 0, t: agora };
  if (agora - u.t > 60000) { u.n = 0; u.t = agora; }
  u.n++; usos.set(chave, u);
  return u.n <= porMinuto;
}
setInterval(() => { const t = Date.now(); for (const [k, u] of usos) if (t - u.t > 120000) usos.delete(k); }, 60000).unref();

function responder(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}
function lerCorpo(req) {
  return new Promise(ok => { let s = ''; req.on('data', c => { s += c; if (s.length > 4096) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
}

// Devolve true se a rota era da loja (já respondida).
async function tratar(req, res, url) {
  if (!url.pathname.startsWith('/api/loja/')) return false;
  // o APK carrega as telas de outra origem: libera CORS (a autenticação é pelo token, sem cookies)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  if (!KEY) { responder(res, 503, { erro: 'loja não configurada no servidor (NEXUS_API_KEY)' }); return true; }
  const eu = await conferirLogin(req);
  if (!eu) { responder(res, 401, { erro: 'faça login para usar a loja' }); return true; }
  if (!limite(eu.uid)) { responder(res, 429, { erro: 'muitas tentativas, aguarde um minuto' }); return true; }
  try {
    const rota = req.method + ' ' + url.pathname;
    if (rota === 'POST /api/loja/entrar') {
      await nexus('POST', '/players', { external_id: eu.uid, username: eu.nome || undefined, platform: 'android' });
      await nexus('POST', '/events', { type: 'session_start', external_id: eu.uid, platform: 'android' });
      return responder(res, 200, { ok: true, id: eu.uid }), true;
    }
    if (rota === 'GET /api/loja/entregas') {
      const lista = await nexus('GET', '/deliveries?external_id=' + encodeURIComponent(eu.uid));
      return responder(res, 200, lista.map(o => ({ code: o.code, total_cents: o.total_cents, items: o.items }))), true;
    }
    if (rota === 'POST /api/loja/confirmar') {
      const { code } = await lerCorpo(req);
      if (!/^NX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(code || ''))) return responder(res, 400, { erro: 'pedido inválido' }), true;
      const o = await nexus('GET', '/purchases/' + code);
      if (o.external_player_id !== eu.uid) return responder(res, 403, { erro: 'esse pedido é de outro jogador' }), true;
      await nexus('POST', `/deliveries/${code}/ack`);
      return responder(res, 200, { ok: true }), true;
    }
    if (rota === 'POST /api/loja/evento') {
      const { tipo } = await lerCorpo(req);
      if (!['session_start', 'install'].includes(tipo)) return responder(res, 400, { erro: 'evento inválido' }), true;
      await nexus('POST', '/events', { type: tipo, external_id: eu.uid, platform: 'android' });
      return responder(res, 200, { ok: true }), true;
    }
    responder(res, 404, { erro: 'rota da loja não encontrada' });
  } catch (e) {
    responder(res, e.status === 401 ? 502 : 502, { erro: 'site da loja indisponível, tente de novo' });
  }
  return true;
}

module.exports = { tratar };
