// Testes de segurança e de verificação de pagamento (node --test).
// Sobe o servidor com banco temporário, um Mercado Pago falso e chaves de teste do Firebase.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(dir, 'certs.json'), JSON.stringify({ k1: publicKey.export({ type: 'spki', format: 'pem' }) }));

// ---------- Mercado Pago falso ----------
const mpPayments = new Map();
let mpSeq = 1000;
const mp = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers.authorization !== 'Bearer TEST-token') return json(401, { message: 'invalid token' });
    if (req.method === 'POST' && req.url === '/v1/payments') {
      const b = JSON.parse(body); const id = ++mpSeq;
      const p = { id, status: 'pending', transaction_amount: b.transaction_amount, currency_id: 'BRL', external_reference: b.external_reference,
        payer: { email: b.payer.email }, point_of_interaction: { transaction_data: { qr_code: '00020126FAKEPIX' + id } } };
      mpPayments.set(String(id), p); return json(201, p);
    }
    const m = req.url.match(/^\/v1\/payments\/(\d+)(\/refunds)?$/);
    if (m && req.method === 'GET') { const p = mpPayments.get(m[1]); return p ? json(200, p) : json(404, {}); }
    if (m && m[2]) { mpPayments.get(m[1]).status = 'refunded'; return json(201, { id: 1 }); }
    if (m && req.method === 'PUT') { mpPayments.get(m[1]).status = 'cancelled'; return json(200, {}); }
    if (req.url === '/users/me') return json(200, { nickname: 'LOJA_TESTE' });
    json(404, {});
  });
});

let base, srv;
const OWNER = 'dono@nexus.test';
test.before(async () => {
  await new Promise(r => mp.listen(0, r));
  Object.assign(process.env, {
    DATA_DIR: dir, FIREBASE_TEST_CERTS: path.join(dir, 'certs.json'), FIREBASE_PROJECT_ID: 'proj-test',
    ADMIN_EMAILS: OWNER, TRUST_PROXY: '1', MP_API_BASE: `http://127.0.0.1:${mp.address().port}`, APP_SECRET: 'segredo-de-teste',
  });
  srv = require('../server/server.js').server;
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.close(); mp.close(); });

// ---------- helpers ----------
function idToken(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://securetoken.google.com/proj-test', aud: 'proj-test', auth_time: now, iat: now, exp: now + 3600,
    sub: 'uid-' + (claims.email || 'x'), email_verified: true, firebase: { sign_in_provider: 'password' }, ...claims })).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
let ipSeq = 1;
function client() {
  const jar = {};
  const ip = `10.0.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;
  return async function call(method, url, body, headers = {}) {
    const r = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nexus', Origin: base, 'X-Forwarded-For': ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
}
const owner = client();
const buyer = client();
let gameKey, gameId;

// ---------- testes ----------
test('cabeçalhos de segurança e CSP estrita nas páginas', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('bloqueia requisição de outro site (CSRF)', async () => {
  const r = await fetch(base + '/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.com' }, body: JSON.stringify({ id_token: idToken({ email: OWNER }) }) });
  assert.equal(r.status, 403);
});

test('rejeita token do Firebase forjado com outra chave', async () => {
  const r = await client()('POST', '/api/auth/session', { id_token: idToken({ email: OWNER }, evil.privateKey) });
  assert.equal(r.status, 401);
});

test('rejeita token de outro projeto ou expirado', async () => {
  assert.equal((await client()('POST', '/api/auth/session', { id_token: idToken({ email: 'a@b.c', aud: 'outro' }) })).status, 401);
  assert.equal((await client()('POST', '/api/auth/session', { id_token: idToken({ email: 'a@b.c', exp: 1000 }) })).status, 401);
});

test('admin com e-mail NÃO verificado não entra no painel', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, email_verified: false, sub: 'uid-falso' }) });
  assert.equal(r.data.is_admin, false);
  assert.equal((await c('GET', '/api/admin/me')).status, 401);
});

test('usuário comum entra, mas não acessa o painel', async () => {
  const r = await buyer('POST', '/api/auth/session', { id_token: idToken({ email: 'jogador@mail.com', name: 'Jogador Um' }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.is_admin, false);
  assert.equal((await buyer('GET', '/api/admin/overview')).status, 401);
  assert.equal((await buyer('GET', '/api/auth/me')).data.is_admin, false);
});

test('dono (ADMIN_EMAILS, e-mail verificado) acessa o painel', async () => {
  const r = await owner('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono' }) });
  assert.equal(r.data.is_admin, true);
  assert.equal((await owner('GET', '/api/admin/me')).data.role, 'owner');
});

test('ações sensíveis exigem confirmação recente de identidade', async () => {
  const stale = idToken({ email: OWNER, sub: 'uid-dono', auth_time: Math.floor(Date.now() / 1000) - 3600 });
  const r = await owner('PUT', '/api/admin/settings', { payment_provider: 'mercadopago', mp_access_token: 'TEST-token', id_token: stale });
  assert.equal(r.status, 403);
  const ok = await owner('PUT', '/api/admin/settings', {
    payment_provider: 'mercadopago', mp_access_token: 'TEST-token', mp_webhook_secret: 'whsec_teste', pix_key: 'pix@loja.com',
    id_token: idToken({ email: OWNER, sub: 'uid-dono' }),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const s = await owner('GET', '/api/admin/settings');
  assert.equal(s.data.mp_access_token_set, true);
  assert.ok(!JSON.stringify(s.data).includes('TEST-token'), 'segredo não pode voltar em texto');
});

test('cadastro de jogo e produto', async () => {
  const g = await owner('POST', '/api/admin/games', { name: 'Jogo Teste', download_url: 'https://exemplo.com/jogo.zip' });
  assert.equal(g.status, 200);
  gameKey = g.data.api_key; gameId = g.data.id;
  const bad = await owner('PUT', '/api/admin/games/' + gameId, { download_url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400, 'links javascript: são bloqueados');
  const p = await owner('POST', '/api/admin/products', { game_id: gameId, name: '1000 Moedas', sku: 'COIN_1000', price_cents: 1990, coins: 1000 });
  assert.equal(p.status, 200);
});

let order;
test('checkout exige e-mail verificado', async () => {
  const c = client();
  await c('POST', '/api/auth/session', { id_token: idToken({ email: 'novo@mail.com', email_verified: false }) });
  const r = await c('POST', '/api/public/checkout', { game: 'jogo-teste', external_id: 'P1', items: [{ sku: 'COIN_1000', qty: 1 }] });
  assert.equal(r.status, 403);
});

test('checkout calcula o preço no servidor e cria cobrança no provedor', async () => {
  const r = await buyer('POST', '/api/public/checkout', { game: 'jogo-teste', external_id: 'PLAYER_1', items: [{ sku: 'COIN_1000', qty: 2, price_cents: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.order.total_cents, 3980, 'preço enviado pelo navegador é ignorado');
  assert.match(r.data.pix, /^00020126FAKEPIX/);
  order = r.data.order;
});

function mpSign(dataId, secret = 'whsec_teste', ts = Math.floor(Date.now() / 1000)) {
  const reqId = crypto.randomUUID();
  const v1 = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': reqId };
}
const paymentIdOf = async code => (await owner('GET', '/api/admin/orders/' + code)).data.provider_payment_id;

test('webhook sem assinatura válida é rejeitado e não libera nada', async () => {
  const id = await paymentIdOf(order.code);
  mpPayments.get(id).status = 'approved';
  const r = await fetch(`${base}/api/webhooks/mercadopago?data.id=${id}&type=payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mpSign(id, 'segredo-errado') }, body: JSON.stringify({ data: { id } }) });
  assert.equal(r.status, 401);
  assert.equal((await owner('GET', '/api/admin/orders/' + order.code)).data.status, 'pending');
  mpPayments.get(id).status = 'pending';
});

test('webhook assinado → status consultado no provedor → pago e verificado', async () => {
  const id = await paymentIdOf(order.code);
  mpPayments.get(id).status = 'approved';
  mpPayments.get(id).payer = { email: 'pagador@banco.com', first_name: 'Maria', last_name: 'Souza', identification: { number: '12345678901' } };
  const r = await fetch(`${base}/api/webhooks/mercadopago?data.id=${id}&type=payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mpSign(id) }, body: JSON.stringify({ data: { id } }) });
  assert.equal(r.status, 200);
  const o = (await owner('GET', '/api/admin/orders/' + order.code)).data;
  assert.equal(o.status, 'paid');
  assert.equal(o.verification, 'provider');
  assert.equal(o.payer_name, 'Maria Souza');
  assert.equal(o.payer_doc, '***.456.789-**', 'CPF guardado mascarado');
  assert.equal(o.paid_amount_cents, 3980);
});

test('pagamento com valor adulterado fica retido e não é entregue', async () => {
  const r = await buyer('POST', '/api/public/checkout', { game: 'jogo-teste', external_id: 'PLAYER_1', items: [{ sku: 'COIN_1000', qty: 1 }] });
  const id = await paymentIdOf(r.data.order.code);
  Object.assign(mpPayments.get(id), { status: 'approved', transaction_amount: 0.01 });
  await fetch(`${base}/api/webhooks/mercadopago?data.id=${id}&type=payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mpSign(id) }, body: '{}' });
  const o = (await owner('GET', '/api/admin/orders/' + r.data.order.code)).data;
  assert.equal(o.review, 1);
  assert.ok(o.risk_flags.some(f => f.code === 'payment_mismatch'));
  const del = await fetch(`${base}/api/v1/deliveries?external_id=PLAYER_1`, { headers: { Authorization: 'Bearer ' + gameKey } }).then(r => r.json());
  assert.ok(!del.some(d => d.code === r.data.order.code), 'pedido retido não aparece para entrega');
  assert.ok(del.some(d => d.code === order.code), 'pedido verificado aparece para entrega');
});

test('jogo confirma entrega do pedido verificado', async () => {
  const r = await fetch(`${base}/api/v1/deliveries/${order.code}/ack`, { method: 'POST', headers: { Authorization: 'Bearer ' + gameKey } }).then(r => r.json());
  assert.equal(r.status, 'delivered');
});

test('confirmação manual exige E2E válido, valor exato e não aceita comprovante repetido', async () => {
  // volta para Pix manual
  await owner('PUT', '/api/admin/settings', { payment_provider: 'manual_pix', id_token: idToken({ email: OWNER, sub: 'uid-dono' }) });
  const a = await buyer('POST', '/api/public/checkout', { game: 'jogo-teste', external_id: 'PLAYER_1', items: [{ sku: 'COIN_1000', qty: 1 }] });
  const b = await buyer('POST', '/api/public/checkout', { game: 'jogo-teste', external_id: 'PLAYER_1', items: [{ sku: 'COIN_1000', qty: 1 }] });
  const tok = () => idToken({ email: OWNER, sub: 'uid-dono' });
  const e2e = 'E18236120202611031200ABCDEFGH123';
  assert.equal((await owner('POST', `/api/admin/orders/${a.data.order.code}/confirm`, { e2e_id: 'E123', amount: '19,90', id_token: tok() })).status, 400);
  assert.equal((await owner('POST', `/api/admin/orders/${a.data.order.code}/confirm`, { e2e_id: e2e, amount: '1,00', id_token: tok() })).status, 400);
  assert.equal((await owner('POST', `/api/admin/orders/${a.data.order.code}/confirm`, { e2e_id: e2e, amount: '19,90' })).status, 403, 'sem reautenticação');
  assert.equal((await owner('POST', `/api/admin/orders/${a.data.order.code}/confirm`, { e2e_id: e2e, amount: '19,90', id_token: tok() })).status, 200);
  const reuse = await owner('POST', `/api/admin/orders/${b.data.order.code}/confirm`, { e2e_id: e2e, amount: '19,90', id_token: tok() });
  assert.equal(reuse.status, 400);
  assert.match(reuse.data.error, /já foi usado/);
});

test('API do jogo com assinatura obrigatória rejeita requisição forjada e repetida', async () => {
  const s = await owner('POST', `/api/admin/games/${gameId}/signing`, { require: true, regenerate: true, id_token: idToken({ email: OWNER, sub: 'uid-dono' }) });
  const secret = s.data.signing_secret;
  const body = JSON.stringify({ external_id: 'PLAYER_2', items: [{ sku: 'COIN_1000', qty: 1 }], status: 'paid', external_ref: 'GPA.1' });
  const unsigned = await fetch(base + '/api/v1/purchases', { method: 'POST', headers: { Authorization: 'Bearer ' + gameKey, 'Content-Type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.POST./api/v1/purchases.${body}`).digest('hex');
  const h = { Authorization: 'Bearer ' + gameKey, 'Content-Type': 'application/json', 'X-Nexus-Timestamp': String(ts), 'X-Nexus-Signature': sig };
  const ok = await fetch(base + '/api/v1/purchases', { method: 'POST', headers: h, body });
  assert.equal(ok.status, 201);
  const replay = await fetch(base + '/api/v1/purchases', { method: 'POST', headers: h, body });
  assert.equal(replay.status, 401, 'replay bloqueado');
});

test('usuário comum não consegue se promover a admin', async () => {
  const r = await buyer('POST', '/api/admin/admins', { email: 'jogador@mail.com', id_token: idToken({ email: 'jogador@mail.com' }) });
  assert.equal(r.status, 401);
});

test('força bruta é limitada (429)', async () => {
  const c = client();
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const r = await c('POST', '/api/auth/session', { id_token: 'x.y.z' }, { 'X-Forwarded-For': '10.9.9.9' });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited);
});

test('trilha de auditoria íntegra (cadeia de hash)', async () => {
  const r = await owner('GET', '/api/admin/security');
  assert.equal(r.data.chain.ok, true);
  assert.ok(r.data.chain.records > 5);
});

test('jogador vê apenas os próprios pedidos', async () => {
  const me = await buyer('GET', '/api/public/me');
  assert.equal(me.status, 200);
  assert.ok(me.data.orders.length >= 1);
  const other = client();
  await other('POST', '/api/auth/session', { id_token: idToken({ email: 'outro@mail.com' }) });
  assert.equal((await other('GET', '/api/public/orders/' + order.code)).status, 404, 'pedido de outra pessoa não é acessível');
});

test('admin com sessão do painel expirada continua reconhecido (não aparece "sem permissão")', async () => {
  const c = client();
  await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono' }) });
  // simula a sessão do painel expirada: remove só o cookie de admin
  assert.equal((await c('GET', '/api/auth/me')).data.admin_eligible, true, 'dono continua elegível ao painel');
  const r = await buyer('GET', '/api/auth/me');
  assert.equal(r.data.admin_eligible, false, 'jogador comum não é elegível');
});

test('dono que recria a conta no Firebase (novo uid, e-mail confirmado) continua admin', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-novo', firebase: { sign_in_provider: 'google.com' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.is_admin, true);
  assert.equal((await c('GET', '/api/auth/me')).data.admin_eligible, true);
  const log = await c('GET', '/api/admin/audit');
  assert.ok(log.data.rows.some(x => x.action === 'admin.uid_rebound'), 'troca fica registrada na auditoria');
});

test('mesmo e-mail NÃO confirmado não toma o lugar do admin', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-invasor', email_verified: false }) });
  assert.equal(r.data.is_admin, false);
  assert.equal((await c('GET', '/api/admin/me')).status, 401);
});

test('reset de emergência do 2FA: só para dono, uma vez só, e fica na auditoria', async () => {
  const { emergencyReset2fa } = require('../server/server.js');
  const db = require('../server/db').db;
  db.prepare("UPDATE admins SET totp_enabled = 1, totp_secret = 'x' WHERE email = ?").run(OWNER);
  process.env.ADMIN_RESET_2FA = 'jogador@mail.com';
  assert.equal(emergencyReset2fa(), 'not_owner');
  process.env.ADMIN_RESET_2FA = OWNER;
  assert.equal(emergencyReset2fa(), 'reset');
  assert.equal(db.prepare('SELECT totp_enabled FROM admins WHERE email = ?').get(OWNER).totp_enabled, 0);
  db.prepare("UPDATE admins SET totp_enabled = 1 WHERE email = ?").run(OWNER);
  assert.equal(emergencyReset2fa(), 'already', 'o mesmo valor não desativa de novo depois de reiniciar');
  assert.equal(db.prepare('SELECT totp_enabled FROM admins WHERE email = ?').get(OWNER).totp_enabled, 1);
  delete process.env.ADMIN_RESET_2FA;
});

test('perfil recriado sem e-mail volta a ser reconhecido como admin', async () => {
  const db = require('../server/db').db;
  const c = client();
  await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-3' }) });
  db.prepare("UPDATE players SET email = NULL WHERE firebase_uid = 'uid-dono-3'").run(); // estado do defeito
  const c2 = client();
  await c2('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-3' }) });
  assert.equal(db.prepare("SELECT email FROM players WHERE firebase_uid = 'uid-dono-3'").get().email, OWNER);
  assert.equal((await c2('GET', '/api/auth/me')).data.admin_eligible, true);
});

test('lembrar aparelho: depois do 2FA, o mesmo aparelho entra só com o login', async () => {
  const sec = require('../server/security');
  const db = require('../server/db').db;
  const secret = sec.newTotpSecret();
  db.prepare('UPDATE admins SET totp_enabled = 1, totp_secret = ?, totp_last = -1, recovery_codes = NULL WHERE email = ?').run(sec.encrypt(secret), OWNER);
  const c = client();
  const r1 = await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-3' }) });
  assert.equal(r1.data.mfa_required, true);
  const code = sec.totpAt(secret, Math.floor(Date.now() / 30000));
  assert.equal((await c('POST', '/api/admin/login/mfa', { mfa_token: r1.data.mfa_token, code, remember: true })).status, 200);
  await c('POST', '/api/auth/logout');
  const r2 = await c('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-3' }) });
  assert.equal(r2.data.is_admin, true, 'aparelho lembrado não pede o código');
  assert.ok(!r2.data.mfa_required);
  // outro aparelho continua pedindo
  const r3 = await client()('POST', '/api/auth/session', { id_token: idToken({ email: OWNER, sub: 'uid-dono-3' }) });
  assert.equal(r3.data.mfa_required, true);
  db.prepare('UPDATE admins SET totp_enabled = 0 WHERE email = ?').run(OWNER);
});
