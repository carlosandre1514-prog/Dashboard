// NEXUS — servidor HTTP: site público, painel admin e API para os jogos.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, hashPassword, checkPassword, newApiKey, newToken, orderCode, getSetting, setSetting } = require('./db');
const analytics = require('./analytics');
const { brCode } = require('./pix');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 14;

// ============================================================ util
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const now = () => new Date().toISOString();
const REPLY = Symbol('reply');
const reply = (status, body, headers) => ({ [REPLY]: true, status, body, headers });

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Payload muito grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}
function setCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

const str = (v, max = 200) => (v == null ? '' : String(v)).trim().slice(0, max);
const int = (v, def = null) => (v === '' || v == null || isNaN(Number(v)) ? def : Math.round(Number(v)));
const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ============================================================ sessões
function createSession(kind, id) {
  const token = newToken();
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token, kind, subject_id, expires_at) VALUES (?,?,?,?)').run(token, kind, id, exp);
  return token;
}
function sessionOf(req, kind) {
  const t = cookies(req)[kind === 'admin' ? 'nx_admin' : 'nx_player'];
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ? AND expires_at > ?').get(t, kind, now());
  return s ? { token: t, id: s.subject_id } : null;
}
function requireAdmin(req) {
  const s = sessionOf(req, 'admin');
  if (!s) throw new HttpError(401, 'Não autenticado');
  return s;
}
function requirePlayer(req) {
  const s = sessionOf(req, 'player');
  if (!s) throw new HttpError(401, 'Faça login para continuar');
  return s;
}
function requireGameKey(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] || '');
  const game = key && db.prepare('SELECT * FROM games WHERE api_key = ?').get(key);
  if (!game) throw new HttpError(401, 'API key inválida');
  return game;
}

// tentativa de login: limite simples por IP
const attempts = new Map();
function throttle(req) {
  const ip = req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  if (++a.n > 20) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  attempts.set(ip, a);
}

// ============================================================ tempo real (SSE)
const streams = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();

// ============================================================ domínio
function gameView(g, withKey = false) {
  if (!g) return null;
  const { api_key, ...rest } = g;
  return { ...rest, platforms: (g.platforms || '').split(',').filter(Boolean), ...(withKey ? { api_key } : {}) };
}
function productView(p) {
  return { ...p, featured: !!p.featured, active: !!p.active };
}

function orderWithItems(o) {
  if (!o) return null;
  o.items = db.prepare('SELECT sku, name, type, qty, unit_cents, coins FROM order_items WHERE order_id = ?').all(o.id);
  return o;
}

const insertEvent = db.prepare(`INSERT INTO events(type, game_id, player_id, visitor_id, platform, country, path, created_at)
  VALUES (?,?,?,?,?,?,?,?)`);
const EVENT_TYPES = new Set(['page_view', 'download', 'install', 'session_start', 'signup']);

function track(e) {
  if (!EVENT_TYPES.has(e.type)) bad('Tipo de evento inválido');
  insertEvent.run(e.type, e.game_id ?? null, e.player_id ?? null, e.visitor_id ? str(e.visitor_id, 64) : null,
    e.platform ? str(e.platform, 16) : null, e.country ? str(e.country, 2).toUpperCase() : null,
    e.path ? str(e.path, 200) : null, e.created_at || now());
  broadcast('event', { type: e.type, game_id: e.game_id, platform: e.platform, at: now() });
}

// cria pedido com itens (validação de SKU e estoque)
function createOrder({ game, items, channel, platform, payment_method, status, player_id, external_player_id, external_ref, customer_name, customer_contact, note }) {
  if (!Array.isArray(items) || !items.length) bad('Pedido sem itens');
  return tx(() => {
    let total = 0, coins = 0, count = 0;
    const lines = items.map(it => {
      const qty = Math.max(1, int(it.qty, 1));
      const p = db.prepare('SELECT * FROM products WHERE game_id = ? AND (sku = ? OR id = ?) AND active = 1')
        .get(game.id, str(it.sku, 64), int(it.product_id, -1));
      if (!p) bad(`Produto não encontrado: ${it.sku ?? it.product_id}`);
      if (p.stock != null && p.stock < qty) bad(`Estoque insuficiente: ${p.name}`);
      total += p.price_cents * qty; coins += p.coins * qty; count += qty;
      return { p, qty };
    });
    if (external_ref) {
      const dup = db.prepare('SELECT * FROM orders WHERE game_id = ? AND external_ref = ?').get(game.id, external_ref);
      if (dup) return { duplicate: true, order: orderWithItems(dup) };
    }
    const code = orderCode();
    const st = ['pending', 'paid', 'delivered'].includes(status) ? status : 'pending';
    const r = db.prepare(`INSERT INTO orders(code, game_id, player_id, external_player_id, external_ref, channel, platform, payment_method,
        status, total_cents, coins_total, items_total, customer_name, customer_contact, note, paid_at, delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, game.id, player_id ?? null, external_player_id ? str(external_player_id, 80) : null, external_ref ? str(external_ref, 120) : null,
      channel, str(platform, 16) || 'web', str(payment_method, 24) || 'pix', st, total, coins, count,
      customer_name ? str(customer_name, 80) : null, customer_contact ? str(customer_contact, 120) : null, note ? str(note, 500) : null,
      st !== 'pending' ? now() : null, st === 'delivered' ? now() : null);
    const oid = Number(r.lastInsertRowid);
    for (const { p, qty } of lines) {
      db.prepare('INSERT INTO order_items(order_id, product_id, sku, name, type, qty, unit_cents, coins) VALUES (?,?,?,?,?,?,?,?)')
        .run(oid, p.id, p.sku, p.name, p.type, qty, p.price_cents, p.coins);
      if (p.stock != null) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
    }
    const order = orderWithItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(oid));
    broadcast('order', { code, game_id: game.id, game: game.name, total_cents: total, coins, status: st, channel, at: order.created_at });
    return { order };
  });
}

function setOrderStatus(order, status) {
  const valid = ['pending', 'paid', 'delivered', 'refunded', 'canceled'];
  if (!valid.includes(status)) bad('Status inválido');
  tx(() => {
    // devolve estoque ao cancelar/estornar
    if (['refunded', 'canceled'].includes(status) && !['refunded', 'canceled'].includes(order.status)) {
      for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(order.id))
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').run(it.qty, it.product_id);
    }
    db.prepare(`UPDATE orders SET status = ?,
      paid_at = CASE WHEN ? IN ('paid','delivered') AND paid_at IS NULL THEN ? ELSE paid_at END,
      delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ?`)
      .run(status, status, now(), status, now(), order.id);
  });
  broadcast('order_status', { code: order.code, status });
  return orderWithItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
}

function pixFor(order) {
  const key = getSetting('pix_key');
  if (!key) return null;
  return brCode({ key, name: getSetting('pix_name') || 'NEXUS', city: getSetting('pix_city') || 'SAO PAULO', amountCents: order.total_cents, txid: order.code });
}

// ============================================================ rotas
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
};

// ---------- admin: autenticação ----------
route('GET', '/api/admin/setup', () => ({ needsSetup: !db.prepare('SELECT 1 FROM admins LIMIT 1').get() }));
route('POST', '/api/admin/setup', async (req, res, { body }) => {
  if (db.prepare('SELECT 1 FROM admins LIMIT 1').get()) throw new HttpError(403, 'Administrador já configurado');
  const email = str(body.email, 120).toLowerCase(), name = str(body.name, 80) || 'Admin';
  if (!/^\S+@\S+\.\S+$/.test(email)) bad('E-mail inválido');
  if (str(body.password, 200).length < 8) bad('A senha precisa de pelo menos 8 caracteres');
  const r = db.prepare('INSERT INTO admins(email, name, pass_hash) VALUES (?,?,?)').run(email, name, hashPassword(body.password));
  const token = createSession('admin', Number(r.lastInsertRowid));
  return reply(200, { ok: true }, { 'Set-Cookie': setCookie('nx_admin', token, SESSION_DAYS * 86400) });
});
route('POST', '/api/admin/login', async (req, res, { body }) => {
  throttle(req);
  const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(str(body.email, 120).toLowerCase());
  if (!a || !checkPassword(str(body.password, 200), a.pass_hash)) throw new HttpError(401, 'E-mail ou senha incorretos');
  const token = createSession('admin', a.id);
  return reply(200, { ok: true }, { 'Set-Cookie': setCookie('nx_admin', token, SESSION_DAYS * 86400) });
});
route('POST', '/api/admin/logout', req => {
  const s = sessionOf(req, 'admin');
  if (s) db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token);
  return reply(200, { ok: true }, { 'Set-Cookie': setCookie('nx_admin', '', 0) });
});
route('GET', '/api/admin/me', req => {
  const s = requireAdmin(req);
  return db.prepare('SELECT id, email, name FROM admins WHERE id = ?').get(s.id);
});

// ---------- admin: analytics ----------
route('GET', '/api/admin/overview', (req, res, { query }) => { requireAdmin(req); return analytics.overview(query); });

route('GET', '/api/admin/feed', (req, res, { query }) => {
  requireAdmin(req);
  const limit = Math.min(100, int(query.limit, 30));
  const orders = db.prepare(`SELECT 'order' kind, o.code, o.status, o.total_cents, o.coins_total, o.channel, o.platform, o.created_at at, g.name game, g.id game_id
    FROM orders o JOIN games g ON g.id=o.game_id ORDER BY o.created_at DESC LIMIT ?`).all(limit);
  const events = db.prepare(`SELECT 'event' kind, e.type, e.platform, e.country, e.created_at at, g.name game, e.game_id
    FROM events e LEFT JOIN games g ON g.id=e.game_id WHERE e.type != 'page_view' ORDER BY e.created_at DESC LIMIT ?`).all(limit);
  return [...orders, ...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
});

route('GET', '/api/admin/stream', (req, res) => {
  requireAdmin(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 4000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
  return null;
});

// ---------- admin: jogos ----------
function gamePayload(b, existing = {}) {
  const name = str(b.name ?? existing.name, 80);
  if (!name) bad('Nome do jogo é obrigatório');
  const platforms = Array.isArray(b.platforms) ? b.platforms.filter(p => ['pc', 'android', 'ios', 'web', 'console'].includes(p)).join(',') : (existing.platforms || 'pc');
  return {
    name, slug: slugify(b.slug || existing.slug || name) || 'jogo',
    tagline: str(b.tagline ?? existing.tagline, 140), description: str(b.description ?? existing.description, 4000),
    genre: str(b.genre ?? existing.genre, 40), status: ['live', 'beta', 'dev', 'paused'].includes(b.status) ? b.status : (existing.status || 'live'),
    version: str(b.version ?? existing.version, 20), platforms, download_url: str(b.download_url ?? existing.download_url, 500),
    cover_url: str(b.cover_url ?? existing.cover_url, 500), accent: /^#[0-9a-f]{6}$/i.test(b.accent || '') ? b.accent : (existing.accent || '#3987e5'),
    currency_name: str(b.currency_name ?? existing.currency_name, 30) || 'Moedas',
  };
}
route('GET', '/api/admin/games', req => {
  requireAdmin(req);
  return db.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM products p WHERE p.game_id=g.id) products,
      (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.game_id=g.id AND o.status IN ('paid','delivered')) revenue,
      (SELECT COALESCE(SUM(coins_total),0) FROM orders o WHERE o.game_id=g.id AND o.status IN ('paid','delivered')) coins,
      (SELECT COUNT(*) FROM events e WHERE e.game_id=g.id AND e.type='download') downloads,
      (SELECT COUNT(DISTINCT player_id) FROM events e WHERE e.game_id=g.id AND e.type='session_start') players
    FROM games g ORDER BY g.created_at`).all().map(g => gameView(g, true));
});
route('POST', '/api/admin/games', (req, res, { body }) => {
  requireAdmin(req);
  const g = gamePayload(body);
  if (db.prepare('SELECT 1 FROM games WHERE slug = ?').get(g.slug)) bad('Já existe um jogo com esse endereço (slug)');
  const r = db.prepare(`INSERT INTO games(slug, name, tagline, description, genre, status, version, platforms, download_url, cover_url, accent, currency_name, api_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(g.slug, g.name, g.tagline, g.description, g.genre, g.status, g.version, g.platforms, g.download_url, g.cover_url, g.accent, g.currency_name, newApiKey());
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(Number(r.lastInsertRowid)), true);
});
route('PUT', '/api/admin/games/:id', (req, res, { params, body }) => {
  requireAdmin(req);
  const cur = db.prepare('SELECT * FROM games WHERE id = ?').get(int(params.id));
  if (!cur) throw new HttpError(404, 'Jogo não encontrado');
  const g = gamePayload(body, cur);
  if (db.prepare('SELECT 1 FROM games WHERE slug = ? AND id != ?').get(g.slug, cur.id)) bad('Já existe um jogo com esse endereço (slug)');
  db.prepare(`UPDATE games SET slug=?, name=?, tagline=?, description=?, genre=?, status=?, version=?, platforms=?, download_url=?, cover_url=?, accent=?, currency_name=? WHERE id=?`)
    .run(g.slug, g.name, g.tagline, g.description, g.genre, g.status, g.version, g.platforms, g.download_url, g.cover_url, g.accent, g.currency_name, cur.id);
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(cur.id), true);
});
route('DELETE', '/api/admin/games/:id', (req, res, { params }) => {
  requireAdmin(req);
  db.prepare('DELETE FROM games WHERE id = ?').run(int(params.id));
  return { ok: true };
});
route('POST', '/api/admin/games/:id/rotate-key', (req, res, { params }) => {
  requireAdmin(req);
  db.prepare('UPDATE games SET api_key = ? WHERE id = ?').run(newApiKey(), int(params.id));
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(int(params.id)), true);
});

// ---------- admin: produtos ----------
const PRODUCT_TYPES = ['currency', 'skin', 'item', 'pass', 'bundle'];
function productPayload(b, ex = {}) {
  const name = str(b.name ?? ex.name, 100);
  if (!name) bad('Nome do produto é obrigatório');
  const price = int(b.price_cents ?? ex.price_cents);
  if (price == null || price < 0) bad('Preço inválido');
  return {
    game_id: int(b.game_id ?? ex.game_id), name, sku: slugify(b.sku || ex.sku || name).toUpperCase().replace(/-/g, '_').slice(0, 48),
    type: PRODUCT_TYPES.includes(b.type) ? b.type : (ex.type || 'currency'), description: str(b.description ?? ex.description, 600),
    price_cents: price, compare_cents: int(b.compare_cents ?? ex.compare_cents), coins: Math.max(0, int(b.coins ?? ex.coins, 0)),
    stock: b.stock === '' || b.stock === null ? null : int(b.stock ?? ex.stock), image_url: str(b.image_url ?? ex.image_url, 500),
    featured: (b.featured ?? ex.featured) ? 1 : 0, active: (b.active ?? ex.active ?? 1) ? 1 : 0,
  };
}
route('GET', '/api/admin/products', (req, res, { query }) => {
  requireAdmin(req);
  const gid = int(query.game);
  return db.prepare(`SELECT p.*, g.name game_name,
      (SELECT COALESCE(SUM(i.qty),0) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.status IN ('paid','delivered')) sold,
      (SELECT COALESCE(SUM(i.qty*i.unit_cents),0) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.status IN ('paid','delivered')) revenue
    FROM products p JOIN games g ON g.id=p.game_id ${gid ? 'WHERE p.game_id = ?' : ''} ORDER BY g.name, p.price_cents`).all(...(gid ? [gid] : [])).map(productView);
});
route('POST', '/api/admin/products', (req, res, { body }) => {
  requireAdmin(req);
  const p = productPayload(body);
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(p.game_id)) bad('Selecione um jogo');
  if (db.prepare('SELECT 1 FROM products WHERE game_id = ? AND sku = ?').get(p.game_id, p.sku)) bad('SKU já usado neste jogo');
  const r = db.prepare(`INSERT INTO products(game_id, sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.game_id, p.sku, p.name, p.type, p.description, p.price_cents, p.compare_cents, p.coins, p.stock, p.image_url, p.featured, p.active);
  return productView(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(r.lastInsertRowid)));
});
route('PUT', '/api/admin/products/:id', (req, res, { params, body }) => {
  requireAdmin(req);
  const ex = db.prepare('SELECT * FROM products WHERE id = ?').get(int(params.id));
  if (!ex) throw new HttpError(404, 'Produto não encontrado');
  const p = productPayload(body, ex);
  if (db.prepare('SELECT 1 FROM products WHERE game_id = ? AND sku = ? AND id != ?').get(p.game_id, p.sku, ex.id)) bad('SKU já usado neste jogo');
  db.prepare(`UPDATE products SET game_id=?, sku=?, name=?, type=?, description=?, price_cents=?, compare_cents=?, coins=?, stock=?, image_url=?, featured=?, active=? WHERE id=?`)
    .run(p.game_id, p.sku, p.name, p.type, p.description, p.price_cents, p.compare_cents, p.coins, p.stock, p.image_url, p.featured, p.active, ex.id);
  return productView(db.prepare('SELECT * FROM products WHERE id = ?').get(ex.id));
});
route('DELETE', '/api/admin/products/:id', (req, res, { params }) => {
  requireAdmin(req);
  db.prepare('DELETE FROM products WHERE id = ?').run(int(params.id));
  return { ok: true };
});

// ---------- admin: pedidos ----------
function orderFilters(query) {
  const cond = [], args = [];
  if (query.status) { cond.push('o.status = ?'); args.push(query.status); }
  if (query.game) { cond.push('o.game_id = ?'); args.push(int(query.game)); }
  if (query.channel) { cond.push('o.channel = ?'); args.push(query.channel); }
  if (query.q) {
    cond.push('(o.code LIKE ? OR o.external_player_id LIKE ? OR p.username LIKE ? OR o.customer_name LIKE ?)');
    const q = `%${str(query.q, 60)}%`; args.push(q, q, q, q);
  }
  return { sql: cond.length ? 'WHERE ' + cond.join(' AND ') : '', args };
}
route('GET', '/api/admin/orders', (req, res, { query }) => {
  requireAdmin(req);
  const f = orderFilters(query);
  const size = Math.min(100, int(query.size, 25)), page = Math.max(1, int(query.page, 1));
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o LEFT JOIN players p ON p.id=o.player_id ${f.sql}`).get(...f.args).n;
  const rows = db.prepare(`SELECT o.*, g.name game_name, g.accent, p.username
    FROM orders o JOIN games g ON g.id=o.game_id LEFT JOIN players p ON p.id=o.player_id ${f.sql}
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...f.args, size, (page - 1) * size);
  return { total, page, size, rows };
});
route('GET', '/api/admin/orders/:code', (req, res, { params }) => {
  requireAdmin(req);
  const o = db.prepare(`SELECT o.*, g.name game_name, p.username, p.email FROM orders o JOIN games g ON g.id=o.game_id
    LEFT JOIN players p ON p.id=o.player_id WHERE o.code = ?`).get(params.code);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return orderWithItems(o);
});
route('PATCH', '/api/admin/orders/:code', (req, res, { params, body }) => {
  requireAdmin(req);
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(params.code);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return setOrderStatus(o, body.status);
});
route('POST', '/api/admin/orders', (req, res, { body }) => {
  requireAdmin(req);
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(int(body.game_id));
  if (!game) bad('Selecione um jogo');
  return createOrder({ game, items: body.items, channel: 'site', platform: body.platform || 'web', payment_method: body.payment_method || 'pix',
    status: body.status || 'paid', external_player_id: body.external_player_id, customer_name: body.customer_name, note: body.note }).order;
});
route('GET', '/api/admin/export/orders.csv', (req, res, { query }) => {
  requireAdmin(req);
  const f = orderFilters(query);
  const rows = db.prepare(`SELECT o.code, o.created_at, g.name game, o.channel, o.platform, o.payment_method, o.status, o.total_cents, o.coins_total, o.items_total,
      COALESCE(p.username, o.customer_name, '') cliente, COALESCE(o.external_player_id, '') player_id
    FROM orders o JOIN games g ON g.id=o.game_id LEFT JOIN players p ON p.id=o.player_id ${f.sql} ORDER BY o.created_at DESC`).all(...f.args);
  const head = ['pedido', 'data', 'jogo', 'canal', 'plataforma', 'pagamento', 'status', 'total', 'moedas', 'itens', 'cliente', 'id_no_jogo'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [head.join(';'), ...rows.map(r => [r.code, r.created_at, r.game, r.channel, r.platform, r.payment_method, r.status,
    (r.total_cents / 100).toFixed(2).replace('.', ','), r.coins_total, r.items_total, r.cliente, r.player_id].map(esc).join(';'))].join('\n');
  return reply(200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pedidos.csv"' });
});

// ---------- admin: jogadores ----------
route('GET', '/api/admin/players', (req, res, { query }) => {
  requireAdmin(req);
  const size = Math.min(100, int(query.size, 25)), page = Math.max(1, int(query.page, 1));
  const cond = [], args = [];
  if (query.q) { cond.push('(p.username LIKE ? OR p.email LIKE ?)'); args.push(`%${str(query.q, 60)}%`, `%${str(query.q, 60)}%`); }
  if (query.game) { cond.push('p.origin_game_id = ?'); args.push(int(query.game)); }
  const w = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM players p ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT p.id, p.username, p.email, p.origin, p.country, p.created_at, p.last_seen_at, g.name origin_game,
      (SELECT COUNT(*) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) orders,
      (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) spent
    FROM players p LEFT JOIN games g ON g.id=p.origin_game_id ${w} ORDER BY ${query.sort === 'spent' ? 'spent DESC' : 'p.created_at DESC'} LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  return { total, page, size, rows };
});

// ---------- admin: configurações ----------
const SETTINGS = ['store_name', 'pix_key', 'pix_name', 'pix_city', 'support_email', 'webhook_secret'];
route('GET', '/api/admin/settings', req => {
  requireAdmin(req);
  return Object.fromEntries(SETTINGS.map(k => [k, getSetting(k) || '']));
});
route('PUT', '/api/admin/settings', (req, res, { body }) => {
  requireAdmin(req);
  for (const k of SETTINGS) if (k in body) setSetting(k, str(body[k], 200));
  return { ok: true };
});
route('POST', '/api/admin/demo', req => {
  requireAdmin(req);
  require('./seed').seed({ reset: false });
  return { ok: true };
});

// ---------- API dos jogos (v1) ----------
route('GET', '/api/v1/catalog', req => {
  const g = requireGameKey(req);
  return {
    game: { id: g.id, slug: g.slug, name: g.name, currency_name: g.currency_name },
    products: db.prepare(`SELECT sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured
      FROM products WHERE game_id = ? AND active = 1 ORDER BY price_cents`).all(g.id).map(p => ({ ...p, featured: !!p.featured })),
  };
});
function playerByExternal(game, externalId) {
  return db.prepare('SELECT p.* FROM player_links l JOIN players p ON p.id=l.player_id WHERE l.game_id = ? AND l.external_id = ?').get(game.id, externalId);
}
route('POST', '/api/v1/players', (req, res, { body }) => {
  const g = requireGameKey(req);
  const ext = str(body.external_id, 80);
  if (!ext) bad('external_id é obrigatório');
  let p = playerByExternal(g, ext);
  if (!p) {
    let username = slugify(body.username || `${g.slug}-${ext}`).slice(0, 32) || `player-${ext}`;
    if (db.prepare('SELECT 1 FROM players WHERE username = ?').get(username)) username = `${username}-${Math.random().toString(36).slice(2, 6)}`;
    const r = db.prepare(`INSERT INTO players(username, origin, origin_game_id, country, last_seen_at) VALUES (?, 'game', ?, ?, ?)`)
      .run(username, g.id, str(body.country, 2).toUpperCase() || 'BR', now());
    db.prepare('INSERT INTO player_links(player_id, game_id, external_id) VALUES (?,?,?)').run(Number(r.lastInsertRowid), g.id, ext);
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(r.lastInsertRowid));
    track({ type: 'signup', game_id: g.id, player_id: p.id, platform: body.platform, country: body.country });
    return reply(201, { player_id: p.id, username: p.username, created: true });
  }
  db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now(), p.id);
  return { player_id: p.id, username: p.username, created: false };
});
route('POST', '/api/v1/events', (req, res, { body }) => {
  const g = requireGameKey(req);
  const list = Array.isArray(body.events) ? body.events.slice(0, 200) : [body];
  tx(() => {
    for (const e of list) {
      const p = e.external_id ? playerByExternal(g, str(e.external_id, 80)) : null;
      if (p) db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now(), p.id);
      track({ type: e.type, game_id: g.id, player_id: p?.id ?? null, visitor_id: e.external_id, platform: e.platform, country: e.country });
    }
  });
  return { ok: true, accepted: list.length };
});
route('POST', '/api/v1/purchases', (req, res, { body }) => {
  const g = requireGameKey(req);
  const ext = str(body.external_id, 80);
  if (!ext) bad('external_id é obrigatório');
  const p = playerByExternal(g, ext);
  const r = createOrder({ game: g, items: body.items, channel: 'in_game', platform: body.platform || 'pc',
    payment_method: body.payment_method || 'store', status: body.status === 'paid' ? 'paid' : 'pending',
    player_id: p?.id, external_player_id: ext, external_ref: body.external_ref });
  const order = r.order;
  return reply(r.duplicate ? 200 : 201, { order: publicOrder(order), pix: order.status === 'pending' && order.payment_method === 'pix' ? pixFor(order) : null, duplicate: !!r.duplicate });
});
route('GET', '/api/v1/purchases/:code', (req, res, { params }) => {
  const g = requireGameKey(req);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND game_id = ?').get(params.code, g.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return publicOrder(orderWithItems(o));
});
route('GET', '/api/v1/deliveries', (req, res, { query }) => {
  const g = requireGameKey(req);
  const ext = str(query.external_id, 80);
  if (!ext) bad('external_id é obrigatório');
  const p = playerByExternal(g, ext);
  return db.prepare(`SELECT * FROM orders WHERE game_id = ? AND status = 'paid' AND (external_player_id = ? OR player_id = ?) ORDER BY created_at`)
    .all(g.id, ext, p?.id ?? -1).map(o => publicOrder(orderWithItems(o)));
});
route('POST', '/api/v1/deliveries/:code/ack', (req, res, { params }) => {
  const g = requireGameKey(req);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND game_id = ?').get(params.code, g.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (o.status === 'delivered') return publicOrder(orderWithItems(o));
  if (o.status !== 'paid') bad('Pedido ainda não está pago');
  return publicOrder(setOrderStatus(o, 'delivered'));
});
function publicOrder(o) {
  return { code: o.code, status: o.status, total_cents: o.total_cents, coins_total: o.coins_total, external_player_id: o.external_player_id,
    channel: o.channel, created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, items: o.items };
}

// webhook do provedor de pagamento (ex.: Mercado Pago / PagSeguro via automação)
route('POST', '/api/webhooks/payment', (req, res, { body }) => {
  const secret = getSetting('webhook_secret');
  if (!secret || req.headers['x-webhook-secret'] !== secret) throw new HttpError(401, 'Assinatura inválida');
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(str(body.code, 40));
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return publicOrder(setOrderStatus(o, body.status || 'paid'));
});

// ---------- público (site) ----------
route('GET', '/api/public/info', () => ({ store_name: getSetting('store_name') || 'NEXUS', support_email: getSetting('support_email') || '' }));
route('GET', '/api/public/games', () =>
  db.prepare(`SELECT g.*, (SELECT MIN(price_cents) FROM products p WHERE p.game_id=g.id AND p.active=1) min_price,
      (SELECT COUNT(*) FROM events e WHERE e.game_id=g.id AND e.type='download') downloads
    FROM games g WHERE g.status != 'paused' ORDER BY g.created_at`).all().map(g => gameView(g)));
route('GET', '/api/public/games/:slug', (req, res, { params }) => {
  const g = db.prepare(`SELECT * FROM games WHERE slug = ? AND status != 'paused'`).get(params.slug);
  if (!g) throw new HttpError(404, 'Jogo não encontrado');
  const products = db.prepare(`SELECT id, sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured
    FROM products WHERE game_id = ? AND active = 1 ORDER BY featured DESC, price_cents`).all(g.id).map(productView);
  const downloads = db.prepare(`SELECT COUNT(*) n FROM events WHERE game_id = ? AND type='download'`).get(g.id).n;
  return { game: { ...gameView(g), downloads }, products };
});
route('POST', '/api/public/track', (req, res, { body }) => {
  if (!['page_view', 'download'].includes(body.type)) bad('Tipo inválido');
  const g = body.game ? db.prepare('SELECT id FROM games WHERE slug = ?').get(str(body.game, 80)) : null;
  const ps = sessionOf(req, 'player');
  const ua = req.headers['user-agent'] || '';
  const platform = /android/i.test(ua) ? 'android' : /iphone|ipad/i.test(ua) ? 'ios' : 'pc';
  track({ type: body.type, game_id: g?.id ?? null, player_id: ps?.id ?? null, visitor_id: body.visitor, platform, country: 'BR', path: body.path });
  return { ok: true };
});
route('POST', '/api/public/register', (req, res, { body }) => {
  throttle(req);
  const username = str(body.username, 32);
  const email = str(body.email, 120).toLowerCase();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) bad('Usuário: 3 a 32 caracteres (letras, números, _ . -)');
  if (!/^\S+@\S+\.\S+$/.test(email)) bad('E-mail inválido');
  if (str(body.password, 200).length < 8) bad('A senha precisa de pelo menos 8 caracteres');
  if (db.prepare('SELECT 1 FROM players WHERE username = ? OR email = ?').get(username, email)) bad('Usuário ou e-mail já cadastrado');
  const r = db.prepare(`INSERT INTO players(username, email, pass_hash, origin, last_seen_at) VALUES (?,?,?, 'site', ?)`)
    .run(username, email, hashPassword(body.password), now());
  const id = Number(r.lastInsertRowid);
  track({ type: 'signup', player_id: id, visitor_id: body.visitor, platform: 'web', country: 'BR' });
  return reply(201, { ok: true }, { 'Set-Cookie': setCookie('nx_player', createSession('player', id), SESSION_DAYS * 86400) });
});
route('POST', '/api/public/login', (req, res, { body }) => {
  throttle(req);
  const login = str(body.login, 120).toLowerCase();
  const p = db.prepare('SELECT * FROM players WHERE lower(username) = ? OR email = ?').get(login, login);
  if (!p || !checkPassword(str(body.password, 200), p.pass_hash)) throw new HttpError(401, 'Usuário ou senha incorretos');
  db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now(), p.id);
  return reply(200, { ok: true }, { 'Set-Cookie': setCookie('nx_player', createSession('player', p.id), SESSION_DAYS * 86400) });
});
route('POST', '/api/public/logout', req => {
  const s = sessionOf(req, 'player');
  if (s) db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token);
  return reply(200, { ok: true }, { 'Set-Cookie': setCookie('nx_player', '', 0) });
});
route('GET', '/api/public/me', req => {
  const s = sessionOf(req, 'player');
  if (!s) return { player: null };
  const player = db.prepare('SELECT id, username, email, created_at FROM players WHERE id = ?').get(s.id);
  const links = db.prepare('SELECT l.game_id, l.external_id, g.slug, g.name FROM player_links l JOIN games g ON g.id=l.game_id WHERE l.player_id = ?').all(s.id);
  const orders = db.prepare(`SELECT o.code, o.status, o.total_cents, o.coins_total, o.created_at, o.external_player_id, g.name game
    FROM orders o JOIN games g ON g.id=o.game_id WHERE o.player_id = ? ORDER BY o.created_at DESC LIMIT 50`).all(s.id);
  return { player, links, orders };
});
route('POST', '/api/public/checkout', (req, res, { body }) => {
  const s = requirePlayer(req);
  const game = db.prepare(`SELECT * FROM games WHERE slug = ? AND status != 'paused'`).get(str(body.game, 80));
  if (!game) bad('Jogo não encontrado');
  const ext = str(body.external_id, 80);
  if (!ext) bad('Informe o seu ID de jogador para receber os itens');
  // vincula a conta do site ao ID no jogo (se ainda não estiver vinculada a outra conta)
  const link = db.prepare('SELECT * FROM player_links WHERE game_id = ? AND external_id = ?').get(game.id, ext);
  if (!link) db.prepare('INSERT INTO player_links(player_id, game_id, external_id) VALUES (?,?,?)').run(s.id, game.id, ext);
  const player = db.prepare('SELECT username, email FROM players WHERE id = ?').get(s.id);
  const { order } = createOrder({ game, items: body.items, channel: 'site', platform: 'web', payment_method: 'pix', status: 'pending',
    player_id: s.id, external_player_id: ext, customer_name: player.username, customer_contact: player.email, note: body.note });
  return reply(201, { order: publicOrder(order), pix: pixFor(order), pix_key: getSetting('pix_key') || '' });
});
route('GET', '/api/public/orders/:code', (req, res, { params }) => {
  const s = requirePlayer(req);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND player_id = ?').get(params.code, s.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return publicOrder(orderWithItems(o));
});

// ============================================================ estáticos
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/' || pathname === '/index.html') file = 'index.html';
  else if (/^\/admin\/?$/.test(pathname)) file = 'admin/index.html';
  else if (/^\/jogo\/[^/]+\/?$/.test(pathname)) file = 'game.html';
  else if (/^\/conta\/?$/.test(pathname)) file = 'account.html';
  else file = pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'Proibido');
  fs.readFile(full, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC, '404.html'), (e2, d2) => send(res, 404, e2 ? 'Não encontrado' : d2, { 'Content-Type': MIME['.html'] }));
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ============================================================ servidor
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/v1/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204, '');
  }
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
    return serveStatic(req, res, pathname);
  }
  const r = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!r) return send(res, 404, { error: 'Rota não encontrada' });
  try {
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler(req, res, { params, body, query: Object.fromEntries(url.searchParams) });
    if (out === null) return; // stream
    if (out && out[REPLY]) return send(res, out.status, out.body, out.headers);
    send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Erro interno' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  NEXUS rodando em http://localhost:${PORT}`);
    console.log(`  Site:   http://localhost:${PORT}/`);
    console.log(`  Painel: http://localhost:${PORT}/admin\n`);
  });
}
module.exports = { server };
