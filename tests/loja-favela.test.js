// Integração do Favela Stricker: módulo do servidor do jogo (sdk/favela-stricker/loja-nexus.js) ↔ site NEXUS.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-fs-'));
const site = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // Firebase do site
const jogo = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // Firebase do jogo
fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify({ k1: site.publicKey.export({ type: 'spki', format: 'pem' }) }));
fs.writeFileSync(path.join(dir, 'jogo.json'), JSON.stringify({ k1: jogo.publicKey.export({ type: 'spki', format: 'pem' }) }));

function token(key, project, claims) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://securetoken.google.com/' + project, aud: project, auth_time: now, iat: now, exp: now + 3600, email_verified: true, ...claims })).toString('base64url');
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url')}`;
}

let nexusBase, gameBase, nexusSrv, gameSrv, jar = '';
test.before(async () => {
  Object.assign(process.env, { DATA_DIR: dir, FIREBASE_TEST_CERTS: path.join(dir, 'site.json'), FIREBASE_PROJECT_ID: 'proj-site', ADMIN_EMAILS: 'dono@x.dev', APP_SECRET: 's' });
  nexusSrv = require('../server/server.js').server;
  await new Promise(r => nexusSrv.listen(0, r));
  nexusBase = `http://127.0.0.1:${nexusSrv.address().port}`;
  // admin cria o jogo e o pacote
  const adm = async (method, url, body) => {
    const r = await fetch(nexusBase + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nexus', Origin: nexusBase, Cookie: jar }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) jar = [jar, c.split(';')[0]].filter(Boolean).join('; ');
    return r.json();
  };
  await adm('POST', '/api/auth/session', { id_token: token(site.privateKey, 'proj-site', { sub: 'dono', email: 'dono@x.dev' }) });
  const g = await adm('POST', '/api/admin/games', { name: 'Favela Stricker' });
  await adm('POST', '/api/admin/products', { game_id: g.id, name: '520 moedas', sku: 'MOEDAS_520', price_cents: 2499, coins: 540 });
  // o servidor do jogo, com o módulo da loja
  Object.assign(process.env, { NEXUS_URL: nexusBase, NEXUS_API_KEY: g.api_key, LOJA_TEST_CERTS: path.join(dir, 'jogo.json') });
  process.env.FIREBASE_PROJECT_ID = 'navegador-f06a8'; // o módulo lê na carga
  const loja = require('../sdk/favela-stricker/loja-nexus.js');
  process.env.FIREBASE_PROJECT_ID = 'proj-site';
  gameSrv = http.createServer(async (req, res) => { if (!(await loja.tratar(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end(); } });
  await new Promise(r => gameSrv.listen(0, r));
  gameBase = `http://127.0.0.1:${gameSrv.address().port}`;
  // jogador compra no site (pedido pago para o uid do jogo)
  const id_token = token(site.privateKey, 'proj-site', { sub: 'dono', email: 'dono@x.dev', auth_time: Math.floor(Date.now() / 1000) });
  const o = await adm('POST', '/api/admin/orders', { game_id: g.id, items: [{ sku: 'MOEDAS_520', qty: 1 }], status: 'paid', external_player_id: 'uidJogador123', id_token });
  assert.ok(o.code, JSON.stringify(o));
});
test.after(() => { nexusSrv.close(); gameSrv.close(); });

const chamar = (method, rota, uid, body) => fetch(gameBase + rota, { method, headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: 'Bearer ' + token(jogo.privateKey, 'navegador-f06a8', { sub: uid, name: 'Zé' }) } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, data: await r.json() }));

test('sem login do jogo não acessa a loja', async () => {
  assert.equal((await chamar('GET', '/api/loja/entregas')).status, 401);
});
test('token de outro projeto Firebase é recusado', async () => {
  const r = await fetch(gameBase + '/api/loja/entregas', { headers: { Authorization: 'Bearer ' + token(site.privateKey, 'proj-site', { sub: 'uidJogador123' }) } });
  assert.equal(r.status, 401);
});
let code;
test('jogador logado vê a compra feita no site', async () => {
  const r = await chamar('GET', '/api/loja/entregas', 'uidJogador123');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].items[0].coins, 540);
  code = r.data[0].code;
});
test('outro jogador não vê nem confirma essa compra', async () => {
  assert.equal((await chamar('GET', '/api/loja/entregas', 'outroUid')).data.length, 0);
  assert.equal((await chamar('POST', '/api/loja/confirmar', 'outroUid', { code })).status, 403);
});
test('dono da compra confirma a entrega → some da lista', async () => {
  assert.equal((await chamar('POST', '/api/loja/confirmar', 'uidJogador123', { code })).status, 200);
  assert.equal((await chamar('GET', '/api/loja/entregas', 'uidJogador123')).data.length, 0);
});
test('registra jogador e sessão no painel', async () => {
  assert.equal((await chamar('POST', '/api/loja/entrar', 'uidJogador123')).status, 200);
});
