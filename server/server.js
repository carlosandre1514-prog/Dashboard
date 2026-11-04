// NEXUS — servidor HTTP: site público, painel admin, API dos jogos e webhooks de pagamento.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, newApiKey, newToken, orderCode, getSetting, setSetting, DATA_DIR, DB_FILE } = require('./db');
const cloud = require('./cloudbackup');
const sec = require('./security');
sec.initKey(DATA_DIR);
const { audit, verifyChain, orderEvent, onAudit } = require('./audit');
const risk = require('./risk');
const pay = require('./payments');
const analytics = require('./analytics');
const fb = require('./firebase');
const { firebase: FIREBASE, ownerEmails } = require('./config');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const ADMIN_IDLE_MIN = Number(process.env.ADMIN_IDLE_MIN || 30);
const ADMIN_MAX_H = 12;
const PLAYER_DAYS = 30;
const MAX_ORDER_CENTS = Number(process.env.MAX_ORDER_CENTS || 200000);
const MAX_PENDING_PER_PLAYER = 3;

// ============================================================ util
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = msg => { throw new HttpError(400, msg); };
const now = () => new Date().toISOString();
const REPLY = Symbol('reply');
const reply = (status, body, headers) => ({ [REPLY]: true, status, body, headers });
const str = (v, max = 200) => (v == null ? '' : String(v)).trim().slice(0, max);
const int = (v, def = null) => (v === '' || v == null || isNaN(Number(v)) ? def : Math.round(Number(v)));
const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const safeUrl = (v, max = 500) => { const s = str(v, max); if (!s) return ''; try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol)) bad('Use um link http(s)'); return u.toString(); } catch (e) { if (e instanceof HttpError) throw e; bad('Link inválido'); } };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 256 * 1024) { reject(new HttpError(413, 'Payload muito grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ raw: '', body: {} });
      try { const body = JSON.parse(raw); if (typeof body !== 'object' || body === null) throw 0; resolve({ raw, body }); }
      catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('='); try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return ['', '']; }
  }));
}
function cookie(req, name, value, maxAgeSec, strict) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${strict ? 'Strict' : 'Lax'}; Max-Age=${maxAgeSec}${sec.isHttps(req) ? '; Secure' : ''}`;
}
const ctxOf = req => ({ ip: req.ip, ua: req.headers['user-agent'] || '' });

// ============================================================ sessões (só o hash do token fica no banco)
function createSession(req, kind, id) {
  const token = newToken();
  const t = now();
  const exp = new Date(Date.now() + (kind === 'admin' ? ADMIN_MAX_H * 3600000 : PLAYER_DAYS * 86400000)).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, kind, subject_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)')
    .run(sec.sha256(token), kind, id, t, t, exp, req.ip, str(req.headers['user-agent'], 200));
  return token;
}
function sessionOf(req, kind) {
  const t = cookies(req)[kind === 'admin' ? 'nx_admin' : 'nx_player'];
  if (!t || t.length > 100) return null;
  const h = sec.sha256(t);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(h, kind);
  if (!s) return null;
  const idleLimit = kind === 'admin' ? ADMIN_IDLE_MIN * 60000 : PLAYER_DAYS * 86400000;
  if (s.expires_at < now() || Date.now() - Date.parse(s.last_seen_at) > idleLimit) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return null;
  }
  if (Date.now() - Date.parse(s.last_seen_at) > 30000) db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE token_hash = ?').run(now(), req.ip, h);
  return { hash: h, id: s.subject_id };
}
function requireAdmin(req) {
  const s = sessionOf(req, 'admin');
  if (!s) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(s.id);
  if (!a || !adminEmails().has(a.email)) throw new HttpError(401, 'Acesso de administrador revogado');
  return { ...a, session: s.hash };
}
function requirePlayer(req) {
  const s = sessionOf(req, 'player');
  if (!s) throw new HttpError(401, 'Faça login para continuar');
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(s.id);
  if (!p) throw new HttpError(401, 'Faça login para continuar');
  if (p.blocked) throw new HttpError(403, 'Conta suspensa. Fale com o suporte.');
  return p;
}
// confirmação forte para ações sensíveis: login recente no Firebase (≤ 5 min) + código 2FA (se ativo)
async function stepUp(req, admin, body) {
  let t;
  try { t = await fb.verifyIdToken(str(body.id_token, 4096)); } catch { t = null; }
  if (!t || t.uid !== admin.firebase_uid || Date.now() / 1000 - t.auth_time > 300) {
    audit('admin', admin.id, 'stepup.failed', { ...ctxOf(req), severity: 'warning' });
    throw new HttpError(403, 'Confirme sua identidade novamente (senha ou Google) para continuar');
  }
  if (admin.totp_enabled) {
    if (!str(body.totp, 6)) throw new HttpError(403, 'Digite o código de 6 dígitos do app autenticador');
    const c = sec.verifyTotp(sec.decrypt(admin.totp_secret), str(body.totp, 6), admin.totp_last);
    if (c < 0) { audit('admin', admin.id, 'stepup.failed_2fa', { ...ctxOf(req), severity: 'warning' }); throw new HttpError(403, sec.totpError(c)); }
    db.prepare('UPDATE admins SET totp_last = ? WHERE id = ?').run(c, admin.id);
  }
}

// bloqueio progressivo de conta após falhas de login
function lockoutCheck(row) {
  if (row?.locked_until && row.locked_until > now()) {
    const min = Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60000);
    throw new HttpError(429, `Conta temporariamente bloqueada por excesso de tentativas. Tente em ${min} min.`);
  }
}
function registerFailure(table, row) {
  if (!row) return;
  const n = row.failed_logins + 1;
  const lock = n >= 5 ? new Date(Date.now() + Math.min(60, 5 * 2 ** (n - 5)) * 60000).toISOString() : null;
  db.prepare(`UPDATE ${table} SET failed_logins = ?, locked_until = ? WHERE id = ?`).run(n, lock, row.id);
}

// ============================================================ tempo real (SSE)
const streams = new Set();
function broadcast(type, data) {
  if (type === 'order' || type === 'order_status' || type === 'order_update') cloud.soon();
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();
pay.onChange((o, prev) => {
  const g = db.prepare('SELECT name FROM games WHERE id = ?').get(o.game_id);
  broadcast(prev === o.status ? 'order_update' : 'order_status', { code: o.code, status: o.status, prev, verification: o.verification, review: o.review, total_cents: o.total_cents, game: g?.name });
});
onAudit(r => { if (r.actor_type === 'admin') cloud.soon(); });
onAudit(r => { if (r.severity !== 'info') broadcast('security', { action: r.action, severity: r.severity, target: r.target, ip: r.ip, at: r.at }); });
sec.setOnBlock((ip, kind) => audit('system', null, 'ip.blocked', { ip, severity: 'critical', details: { reason: `limite excedido repetidamente (${kind})`, minutes: 15 } }));

// ============================================================ domínio
const gameView = (g, admin = false) => {
  if (!g) return null;
  const { api_key, signing_secret, ...rest } = g;
  return { ...rest, require_signature: !!g.require_signature, platforms: (g.platforms || '').split(',').filter(Boolean), ...(admin ? { api_key, has_signing_secret: !!signing_secret } : {}) };
};
const productView = p => ({ ...p, featured: !!p.featured, active: !!p.active });
function orderWithItems(o) {
  if (!o) return null;
  o.items = db.prepare('SELECT sku, name, type, qty, unit_cents, coins FROM order_items WHERE order_id = ?').all(o.id);
  return o;
}
const insertEvent = db.prepare('INSERT INTO events(type, game_id, player_id, visitor_id, platform, country, path, created_at) VALUES (?,?,?,?,?,?,?,?)');
const EVENT_TYPES = new Set(['page_view', 'download', 'install', 'session_start', 'signup']);
function track(e) {
  if (!EVENT_TYPES.has(e.type)) bad('Tipo de evento inválido');
  insertEvent.run(e.type, e.game_id ?? null, e.player_id ?? null, e.visitor_id ? str(e.visitor_id, 64) : null,
    e.platform ? str(e.platform, 16) : null, e.country ? str(e.country, 2).toUpperCase() : null, e.path ? str(e.path, 200) : null, now());
  broadcast('event', { type: e.type, game_id: e.game_id, platform: e.platform, at: now() });
}

// cria pedido: preços SEMPRE calculados no servidor, estoque travado, risco avaliado
function createOrder(o) {
  const { game, items, channel } = o;
  if (!Array.isArray(items) || !items.length || items.length > 20) bad('Pedido sem itens válidos');
  return tx(() => {
    if (o.external_ref) {
      const dup = db.prepare('SELECT * FROM orders WHERE game_id = ? AND external_ref = ?').get(game.id, o.external_ref);
      if (dup) return { duplicate: true, order: orderWithItems(dup) };
    }
    let total = 0, coins = 0, count = 0;
    const lines = items.map(it => {
      const qty = int(it.qty, 1);
      if (!(qty >= 1 && qty <= 20)) bad('Quantidade inválida (1 a 20)');
      const p = db.prepare('SELECT * FROM products WHERE game_id = ? AND (sku = ? OR id = ?) AND active = 1').get(game.id, str(it.sku, 64), int(it.product_id, -1));
      if (!p) bad(`Produto indisponível: ${str(it.sku ?? it.product_id, 40)}`);
      if (p.stock != null && p.stock < qty) bad(`Estoque insuficiente: ${p.name}`);
      total += p.price_cents * qty; coins += p.coins * qty; count += qty;
      return { p, qty };
    });
    if (channel === 'site' && total > MAX_ORDER_CENTS) bad(`Valor máximo por pedido: R$ ${(MAX_ORDER_CENTS / 100).toFixed(2)}`);
    const r = risk.assess({ playerId: o.player_id, ip: o.ip, totalCents: total, gameId: game.id, externalId: o.external_player_id, channel });
    if (r.flags.some(f => f.code === 'blocked')) throw new HttpError(403, 'Conta suspensa');
    const code = orderCode();
    const st = ['pending', 'paid', 'delivered'].includes(o.status) ? o.status : 'pending';
    const res = db.prepare(`INSERT INTO orders(code, game_id, player_id, external_player_id, external_ref, channel, platform, payment_method, status,
        total_cents, coins_total, items_total, customer_name, customer_contact, note, paid_at, delivered_at,
        provider, verification, verified_by, verified_at, paid_amount_cents, risk_score, risk_flags, review, ip, user_agent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, game.id, o.player_id ?? null, o.external_player_id ? str(o.external_player_id, 80) : null, o.external_ref ? str(o.external_ref, 120) : null,
      channel, str(o.platform, 16) || 'web', str(o.payment_method, 24) || 'pix', st, total, coins, count,
      o.customer_name ? str(o.customer_name, 80) : null, o.customer_contact ? str(o.customer_contact, 120) : null, o.note ? str(o.note, 300) : null,
      st !== 'pending' ? now() : null, st === 'delivered' ? now() : null,
      o.provider || null, o.verification || 'none', o.verified_by ?? null, o.verification && o.verification !== 'none' ? now() : null,
      st !== 'pending' ? total : null, r.score, JSON.stringify(r.flags), r.review ? 1 : 0, o.ip || null, o.ua ? str(o.ua, 200) : null);
    const oid = Number(res.lastInsertRowid);
    for (const { p, qty } of lines) {
      db.prepare('INSERT INTO order_items(order_id, product_id, sku, name, type, qty, unit_cents, coins) VALUES (?,?,?,?,?,?,?,?)').run(oid, p.id, p.sku, p.name, p.type, qty, p.price_cents, p.coins);
      if (p.stock != null) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
    }
    orderEvent(oid, 'created', `Pedido criado via ${channel === 'site' ? 'site' : 'jogo'}${r.score ? ` — risco ${r.score}/100` : ''}`, o.actor || 'system', r.flags.length ? { flags: r.flags } : null);
    if (r.review) orderEvent(oid, 'alert', 'Pedido retido para análise antifraude: ' + r.flags.map(f => f.text).join('; '), 'antifraude');
    const order = orderWithItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(oid));
    broadcast('order', { code, game_id: game.id, game: game.name, total_cents: total, coins, status: st, channel, review: r.review, at: order.created_at });
    return { order };
  });
}
function publicOrder(o) {
  return { code: o.code, status: o.status, in_review: !!o.review, total_cents: o.total_cents, coins_total: o.coins_total, external_player_id: o.external_player_id,
    channel: o.channel, created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, expires_at: o.expires_at, items: o.items };
}
const orderByCode = code => db.prepare('SELECT * FROM orders WHERE code = ?').get(str(code, 20));

// ============================================================ rotas
const routes = [];
// opts: auth = 'admin' | 'player' | 'game' | 'none' (define CSRF e limite)
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, opts });
};

// ---------------------------------------------------------------- autenticação (Firebase)
// Uma única conta para todos. O servidor confere o token do Firebase e decide o papel:
// e-mail verificado presente na lista de administradores → acesso ao painel; senão → só loja.
function adminEmails() {
  let extra = [];
  try { extra = JSON.parse(getSetting('admin_emails') || '[]'); } catch { }
  return new Set([...ownerEmails(), ...extra.map(e => String(e).toLowerCase())]);
}
const isOwner = email => ownerEmails().includes(String(email).toLowerCase());
function uniqueUsername(base) {
  let u = slugify(base).replace(/-/g, '_').slice(0, 24) || 'jogador';
  if (u.length < 3) u = 'jogador_' + u;
  while (db.prepare('SELECT 1 FROM players WHERE username = ?').get(u)) u = u.slice(0, 24) + '_' + require('node:crypto').randomBytes(2).toString('hex');
  return u;
}
const mfaPending = new Map(); // token → { id, exp, tries }
route('GET', '/api/public/config', () => ({ firebase: FIREBASE }));
route('POST', '/api/auth/session', async (req, res, { body }) => {
  const t = await fb.verifyIdToken(str(body.id_token, 4096)).catch(e => { throw new HttpError(401, e.message); });
  if (!t.email) bad('Sua conta precisa ter um e-mail');
  let p = db.prepare('SELECT * FROM players WHERE firebase_uid = ?').get(t.uid);
  if (!p) {
    p = db.prepare('SELECT * FROM players WHERE email = ?').get(t.email);
    if (p && t.email_verified) {
      if (p.firebase_uid && p.firebase_uid !== t.uid) audit('player', p.id, 'player.uid_rebound', { ...ctxOf(req), target: t.email, severity: 'warning', details: { provider: t.provider } });
      db.prepare('UPDATE players SET firebase_uid = ? WHERE id = ?').run(t.uid, p.id);
    } else {
      if (db.prepare('SELECT COUNT(*) n FROM players WHERE signup_ip = ? AND created_at > ?').get(req.ip, new Date(Date.now() - 3600000).toISOString()).n >= 5)
        throw new HttpError(429, 'Muitas contas criadas a partir desta rede. Tente mais tarde.');
      const name = str(body.name || t.name, 60);
      // e-mail já usado: conta verificada tem prioridade; quem não confirmou o e-mail perde o vínculo
      let email = t.email;
      const taken = db.prepare('SELECT id, email_verified FROM players WHERE email = ?').get(t.email);
      if (taken) {
        if (t.email_verified && !taken.email_verified) db.prepare('UPDATE players SET email = NULL WHERE id = ?').run(taken.id);
        else email = null;
      }
      const r = db.prepare(`INSERT INTO players(username, email, display_name, firebase_uid, email_verified, origin, last_seen_at, signup_ip, last_ip) VALUES (?,?,?,?,?, 'site', ?, ?, ?)`)
        .run(uniqueUsername(name || t.email.split('@')[0]), email, name || null, t.uid, t.email_verified ? 1 : 0, now(), req.ip, req.ip);
      p = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(r.lastInsertRowid));
      track({ type: 'signup', player_id: p.id, visitor_id: body.visitor, platform: 'web', country: 'BR' });
    }
  }
  if (p.blocked) { audit('player', p.id, 'player.blocked_login', { ...ctxOf(req), severity: 'warning' }); throw new HttpError(403, 'Conta suspensa. Fale com o suporte.'); }
  db.prepare('UPDATE players SET email_verified = ?, last_seen_at = ?, last_ip = ? WHERE id = ?').run(t.email_verified ? 1 : 0, now(), req.ip, p.id);
  const cookiesOut = [cookie(req, 'nx_player', createSession(req, 'player', p.id), PLAYER_DAYS * 86400)];
  const out = { ok: true, is_admin: false, email_verified: t.email_verified };
  if (adminEmails().has(t.email)) {
    if (!t.email_verified) {
      out.admin_pending = 'Confirme seu e-mail para liberar o acesso ao painel.';
    } else {
      let a = db.prepare('SELECT * FROM admins WHERE email = ?').get(t.email);
      if (!a) {
        const r = db.prepare("INSERT INTO admins(email, name, pass_hash, firebase_uid, role) VALUES (?,?,'',?,?)").run(t.email, t.name || t.email.split('@')[0], t.uid, isOwner(t.email) ? 'owner' : 'admin');
        a = db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(r.lastInsertRowid));
        audit('admin', a.id, 'admin.created', { ...ctxOf(req), severity: 'warning', details: { email: t.email } });
      } else if (a.firebase_uid !== t.uid) {
        // novo login no Firebase para o mesmo e-mail CONFIRMADO (ex.: conta recriada pelo Google)
        if (a.firebase_uid) audit('admin', a.id, 'admin.uid_rebound', { ...ctxOf(req), target: t.email, severity: 'critical', details: { provider: t.provider } });
        db.prepare('UPDATE admins SET firebase_uid = ? WHERE id = ?').run(t.uid, a.id);
        a.firebase_uid = t.uid;
      }
      lockoutCheck(a);
      db.prepare('UPDATE admins SET login_provider = ? WHERE id = ?').run(t.provider || null, a.id);
      if (a.totp_enabled) {
        const mt = newToken();
        mfaPending.set(mt, { id: a.id, exp: Date.now() + 5 * 60000, tries: 0 });
        Object.assign(out, { mfa_required: true, mfa_token: mt });
      } else {
        cookiesOut.push(adminLoginCookie(req, a));
        out.is_admin = true;
      }
    }
  }
  return reply(200, out, { 'Set-Cookie': cookiesOut });
}, { limit: 'auth', csrf: true });
function adminLoginCookie(req, a) {
  db.prepare('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(now(), req.ip, a.id);
  audit('admin', a.id, 'admin.login', ctxOf(req));
  return cookie(req, 'nx_admin', createSession(req, 'admin', a.id), ADMIN_MAX_H * 3600, true);
}
route('POST', '/api/admin/login/mfa', async (req, res, { body }) => {
  const p = mfaPending.get(str(body.mfa_token, 100));
  if (!p || p.exp < Date.now()) throw new HttpError(401, 'Etapa de verificação expirada. Entre novamente.');
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(p.id);
  lockoutCheck(a);
  const code = str(body.code, 20).toUpperCase();
  let ok = false, why = -1;
  if (/^\d{6}$/.test(code)) {
    const c = sec.verifyTotp(sec.decrypt(a.totp_secret), code, a.totp_last);
    if (c >= 0) { ok = true; db.prepare('UPDATE admins SET totp_last = ? WHERE id = ?').run(c, a.id); } else why = c;
  } else if (/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code)) {
    const list = JSON.parse(a.recovery_codes || '[]');
    const i = list.indexOf(sec.sha256(code));
    if (i >= 0) { ok = true; list.splice(i, 1); db.prepare('UPDATE admins SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(list), a.id); audit('admin', a.id, '2fa.recovery_used', { ...ctxOf(req), severity: 'warning', details: { remaining: list.length } }); }
  }
  if (!ok) {
    if (++p.tries >= 5) mfaPending.delete(str(body.mfa_token, 100));
    registerFailure('admins', a);
    audit('admin', a.id, 'admin.2fa_failed', { ...ctxOf(req), severity: 'warning' });
    throw new HttpError(401, why === -2 ? sec.totpError(-2) : 'Código inválido');
  }
  mfaPending.delete(str(body.mfa_token, 100));
  return reply(200, { ok: true, is_admin: true }, { 'Set-Cookie': adminLoginCookie(req, a) });
}, { limit: 'auth', csrf: true });
setInterval(() => { for (const [k, v] of mfaPending) if (v.exp < Date.now()) mfaPending.delete(k); }, 60000).unref();

route('POST', '/api/auth/logout', async req => {
  for (const kind of ['admin', 'player']) {
    const s = sessionOf(req, kind);
    if (s) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.hash); if (kind === 'admin') audit('admin', s.id, 'admin.logout', ctxOf(req)); }
  }
  return reply(200, { ok: true }, { 'Set-Cookie': [cookie(req, 'nx_admin', '', 0, true), cookie(req, 'nx_player', '', 0)] });
}, { csrf: true });
route('GET', '/api/auth/me', async req => {
  const ps = sessionOf(req, 'player');
  const player = ps && db.prepare('SELECT id, username, display_name, email, email_verified, created_at FROM players WHERE id = ? AND blocked = 0').get(ps.id);
  const as = sessionOf(req, 'admin');
  const admin = as && db.prepare('SELECT id, email, name, role, totp_enabled FROM admins WHERE id = ?').get(as.id);
  const eligible = !!player && !!player.email_verified && !!player.email && adminEmails().has(String(player.email).toLowerCase());
  return { player: player ? { ...player, email_verified: !!player.email_verified } : null, is_admin: !!admin && adminEmails().has(admin.email), admin_eligible: eligible };
});
route('GET', '/api/admin/me', async req => {
  const a = requireAdmin(req);
  return { id: a.id, email: a.email, name: a.name, role: a.role, provider: a.login_provider || null, totp_enabled: !!a.totp_enabled, idle_minutes: ADMIN_IDLE_MIN, last_login_at: a.last_login_at, last_login_ip: a.last_login_ip };
});

// ---------- administradores (somente donos definidos em ADMIN_EMAILS) ----------
route('GET', '/api/admin/admins', async req => {
  requireAdmin(req);
  let extra = []; try { extra = JSON.parse(getSetting('admin_emails') || '[]'); } catch { }
  const rows = db.prepare('SELECT email, name, role, totp_enabled, last_login_at FROM admins').all();
  const all = [...new Set([...ownerEmails(), ...extra])];
  return all.map(e => { const r = rows.find(x => x.email === e); return { email: e, owner: isOwner(e), name: r?.name || null, totp_enabled: !!r?.totp_enabled, last_login_at: r?.last_login_at || null, activated: !!r }; });
});
route('POST', '/api/admin/admins', async (req, res, { body }) => {
  const a = requireAdmin(req);
  if (!isOwner(a.email)) throw new HttpError(403, 'Só o dono do sistema pode gerenciar administradores');
  await stepUp(req, a, body);
  const email = str(body.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('E-mail inválido');
  let list = []; try { list = JSON.parse(getSetting('admin_emails') || '[]'); } catch { }
  if (body.remove) {
    if (isOwner(email)) bad('Donos são definidos no servidor (ADMIN_EMAILS)');
    list = list.filter(e => e !== email);
    const ad = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
    if (ad) { db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ?").run(ad.id); db.prepare('DELETE FROM admins WHERE id = ?').run(ad.id); }
  } else if (!list.includes(email)) list.push(email);
  setSetting('admin_emails', JSON.stringify(list));
  audit('admin', a.id, body.remove ? 'admin.removed' : 'admin.added', { ...ctxOf(req), target: email, severity: 'critical' });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });

// ---------- 2FA ----------
route('POST', '/api/admin/2fa/setup', async req => {
  const a = requireAdmin(req);
  if (a.totp_enabled) bad('A verificação em duas etapas já está ativa');
  const secret = sec.newTotpSecret();
  db.prepare('UPDATE admins SET totp_secret = ? WHERE id = ?').run(sec.encrypt(secret), a.id);
  return { secret, uri: sec.otpauthUri(secret, a.email, (getSetting('store_name') || 'NEXUS').replace(/[:]/g, '')) };
}, { csrf: true });
route('POST', '/api/admin/2fa/enable', async (req, res, { body }) => {
  const a = requireAdmin(req);
  if (!a.totp_secret) bad('Inicie a configuração primeiro');
  const c = sec.verifyTotp(sec.decrypt(a.totp_secret), str(body.code, 6), -1);
  if (c < 0) bad('Código incorreto. Confira o horário do celular e tente de novo.');
  const codes = sec.recoveryCodes();
  db.prepare('UPDATE admins SET totp_enabled = 1, totp_last = ?, recovery_codes = ? WHERE id = ?').run(c, JSON.stringify(codes.map(sec.sha256)), a.id);
  audit('admin', a.id, '2fa.enabled', { ...ctxOf(req), severity: 'warning' });
  return { ok: true, recovery_codes: codes };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/2fa/disable', async (req, res, { body }) => {
  const a = requireAdmin(req);
  await stepUp(req, a, body);
  db.prepare('UPDATE admins SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?').run(a.id);
  audit('admin', a.id, '2fa.disabled', { ...ctxOf(req), severity: 'critical' });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });

// ---------- segurança ----------
route('GET', '/api/admin/security', async req => {
  const a = requireAdmin(req);
  const s = k => !!getSetting(k);
  const https = sec.isHttps(req);
  const checks = [
    { ok: https, label: 'Conexão HTTPS', hint: https ? 'Tráfego criptografado' : 'Publique atrás de HTTPS (Caddy, Nginx, Cloudflare) e defina TRUST_PROXY=1' },
    { ok: !!a.totp_enabled, label: 'Verificação em duas etapas (2FA)', hint: a.totp_enabled ? 'Ativa na sua conta' : 'Ative abaixo — protege mesmo se a senha vazar' },
    { ok: pay.provider() === 'mercadopago', label: 'Verificação automática de pagamento', hint: pay.provider() === 'mercadopago' ? 'Mercado Pago conectado — status conferido direto na API' : 'Pix estático exige conferência manual do extrato' },
    { ok: pay.provider() !== 'mercadopago' || s('mp_webhook_secret'), label: 'Assinatura do webhook', hint: pay.provider() !== 'mercadopago' ? 'Não se aplica ao Pix manual' : s('mp_webhook_secret') ? 'Notificações sem assinatura válida são rejeitadas' : 'Cadastre a chave secreta do webhook do Mercado Pago' },
    { ok: cloud.enabled() && !cloud.status().error, label: 'Backup criptografado na nuvem', hint: !cloud.enabled() ? 'Desativado — em hospedagem gratuita defina FIREBASE_SERVICE_ACCOUNT, senão os dados se perdem ao reiniciar' : cloud.status().error ? 'Última tentativa falhou: ' + cloud.status().error.message : cloud.status().last ? `Última cópia ${new Date(cloud.status().last.at).toLocaleString('pt-BR')} · ${Math.ceil(cloud.status().last.bytes / 1024)} KB` : 'Ativo — a primeira cópia sai na próxima alteração' },
    { ok: !!process.env.APP_SECRET, label: 'Chave mestra de criptografia em variável de ambiente', hint: process.env.APP_SECRET ? 'APP_SECRET definida' : 'Usando data/secret.key — em produção defina APP_SECRET fora do servidor de arquivos' },
    { ok: db.prepare('SELECT COUNT(*) n FROM games').get().n === 0 || db.prepare('SELECT COUNT(*) n FROM games WHERE require_signature = 0').get().n === 0, label: 'Jogos com assinatura obrigatória', hint: 'Exija requisições assinadas (HMAC) em Integração · API para bloquear compras forjadas' },
  ];
  return {
    checks,
    chain: verifyChain(),
    blocked: sec.blockedList(),
    sessions: db.prepare("SELECT token_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE kind = 'admin' AND subject_id = ? AND expires_at > ? ORDER BY last_seen_at DESC").all(a.id, now())
      .map(x => ({ id: x.token_hash.slice(0, 16), current: x.token_hash === a.session, created_at: x.created_at, last_seen_at: x.last_seen_at, ip: x.ip, user_agent: x.user_agent })),
    stats: db.prepare(`SELECT
        SUM(action LIKE '%login_failed%' OR action LIKE '%2fa_failed%') failed_logins,
        SUM(action = 'webhook.rejected') webhook_rejected, SUM(action = 'ip.blocked') ip_blocked,
        SUM(action = 'payment.mismatch') mismatches, SUM(action = 'api.signature_rejected') bad_signatures
      FROM audit_log WHERE at > ?`).get(new Date(Date.now() - 7 * 86400000).toISOString()),
    review_count: db.prepare('SELECT COUNT(*) n FROM orders WHERE review = 1 AND status IN (\'paid\',\'pending\')').get().n,
    totp_enabled: !!a.totp_enabled,
    recovery_left: JSON.parse(a.recovery_codes || '[]').length,
  };
});
route('GET', '/api/admin/audit', async (req, res, { query }) => {
  requireAdmin(req);
  const size = 50, page = Math.max(1, int(query.page, 1));
  const cond = query.severity ? 'WHERE severity = ?' : '';
  const args = query.severity ? [query.severity] : [];
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${cond}`).get(...args).n;
  const rows = db.prepare(`SELECT l.id, l.at, l.actor_type, l.actor_id, a.name actor_name, l.action, l.target, l.ip, l.severity, l.details, l.hash
    FROM audit_log l LEFT JOIN admins a ON l.actor_type = 'admin' AND a.id = CAST(l.actor_id AS INTEGER) ${cond.replace('severity', 'l.severity')} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  return { total, page, size, rows };
});
route('POST', '/api/admin/sessions/revoke', async (req, res, { body }) => {
  const a = requireAdmin(req);
  if (body.all) db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ? AND token_hash != ?").run(a.id, a.session);
  else db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ? AND substr(token_hash, 1, 16) = ? AND token_hash != ?").run(a.id, str(body.id, 16), a.session);
  audit('admin', a.id, 'sessions.revoked', { ...ctxOf(req), severity: 'warning', details: { all: !!body.all } });
  return { ok: true };
}, { csrf: true });
route('POST', '/api/admin/security/unblock', async (req, res, { body }) => {
  const a = requireAdmin(req);
  sec.blockIp(str(body.ip, 64), 0);
  audit('admin', a.id, 'ip.unblocked', { ...ctxOf(req), target: str(body.ip, 64) });
  return { ok: true };
}, { csrf: true });

// ---------------------------------------------------------------- admin: analytics
route('GET', '/api/admin/overview', async (req, res, { query }) => { requireAdmin(req); return analytics.overview(query); });
route('GET', '/api/admin/feed', async (req, res, { query }) => {
  requireAdmin(req);
  const limit = Math.min(100, int(query.limit, 30));
  const orders = db.prepare(`SELECT 'order' kind, o.code, o.status, o.total_cents, o.coins_total, o.channel, o.platform, o.verification, o.review, o.created_at at, g.name game, g.id game_id
    FROM orders o JOIN games g ON g.id=o.game_id ORDER BY o.created_at DESC LIMIT ?`).all(limit);
  const events = db.prepare(`SELECT 'event' kind, e.type, e.platform, e.country, e.created_at at, g.name game, e.game_id
    FROM events e LEFT JOIN games g ON g.id=e.game_id WHERE e.type != 'page_view' ORDER BY e.created_at DESC LIMIT ?`).all(limit);
  return [...orders, ...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
});
route('GET', '/api/admin/stream', async (req, res) => {
  requireAdmin(req);
  if (streams.size >= 20) throw new HttpError(429, 'Muitas conexões abertas');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 4000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
  return null;
});

// ---------------------------------------------------------------- admin: jogos
function gamePayload(b, ex = {}) {
  const name = str(b.name ?? ex.name, 80);
  if (!name) bad('Nome do jogo é obrigatório');
  const platforms = Array.isArray(b.platforms) ? b.platforms.filter(p => ['pc', 'android', 'ios', 'web', 'console'].includes(p)).join(',') : (ex.platforms || 'pc');
  return {
    name, slug: slugify(b.slug || ex.slug || name).slice(0, 60) || 'jogo',
    tagline: str(b.tagline ?? ex.tagline, 140), description: str(b.description ?? ex.description, 4000),
    genre: str(b.genre ?? ex.genre, 40), status: ['live', 'beta', 'dev', 'paused'].includes(b.status) ? b.status : (ex.status || 'live'),
    version: str(b.version ?? ex.version, 20), platforms,
    download_url: 'download_url' in b ? safeUrl(b.download_url) : (ex.download_url || ''),
    cover_url: 'cover_url' in b ? safeUrl(b.cover_url) : (ex.cover_url || ''),
    accent: /^#[0-9a-f]{6}$/i.test(b.accent || '') ? b.accent : (ex.accent || '#3987e5'),
    currency_name: str(b.currency_name ?? ex.currency_name, 30) || 'Moedas',
  };
}
route('GET', '/api/admin/games', async req => {
  requireAdmin(req);
  return db.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM products p WHERE p.game_id=g.id) products,
      (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.game_id=g.id AND o.status IN ('paid','delivered')) revenue,
      (SELECT COALESCE(SUM(coins_total),0) FROM orders o WHERE o.game_id=g.id AND o.status IN ('paid','delivered')) coins,
      (SELECT COUNT(*) FROM events e WHERE e.game_id=g.id AND e.type='download') downloads,
      (SELECT COUNT(DISTINCT player_id) FROM events e WHERE e.game_id=g.id AND e.type='session_start') players
    FROM games g ORDER BY g.created_at`).all().map(g => gameView(g, true));
});
route('POST', '/api/admin/games', async (req, res, { body }) => {
  const a = requireAdmin(req);
  const g = gamePayload(body);
  if (db.prepare('SELECT 1 FROM games WHERE slug = ?').get(g.slug)) bad('Já existe um jogo com esse endereço (slug)');
  const r = db.prepare(`INSERT INTO games(slug, name, tagline, description, genre, status, version, platforms, download_url, cover_url, accent, currency_name, api_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(g.slug, g.name, g.tagline, g.description, g.genre, g.status, g.version, g.platforms, g.download_url, g.cover_url, g.accent, g.currency_name, newApiKey());
  audit('admin', a.id, 'game.created', { ...ctxOf(req), target: g.slug });
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(Number(r.lastInsertRowid)), true);
}, { csrf: true });
route('PUT', '/api/admin/games/:id', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  const cur = db.prepare('SELECT * FROM games WHERE id = ?').get(int(params.id));
  if (!cur) throw new HttpError(404, 'Jogo não encontrado');
  const g = gamePayload(body, cur);
  if (db.prepare('SELECT 1 FROM games WHERE slug = ? AND id != ?').get(g.slug, cur.id)) bad('Já existe um jogo com esse endereço (slug)');
  db.prepare(`UPDATE games SET slug=?, name=?, tagline=?, description=?, genre=?, status=?, version=?, platforms=?, download_url=?, cover_url=?, accent=?, currency_name=? WHERE id=?`)
    .run(g.slug, g.name, g.tagline, g.description, g.genre, g.status, g.version, g.platforms, g.download_url, g.cover_url, g.accent, g.currency_name, cur.id);
  audit('admin', a.id, 'game.updated', { ...ctxOf(req), target: g.slug });
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(cur.id), true);
}, { csrf: true });
route('DELETE', '/api/admin/games/:id', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  await stepUp(req, a, body);
  const g = db.prepare('SELECT slug FROM games WHERE id = ?').get(int(params.id));
  db.prepare('DELETE FROM games WHERE id = ?').run(int(params.id));
  audit('admin', a.id, 'game.deleted', { ...ctxOf(req), target: g?.slug, severity: 'critical' });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/games/:id/rotate-key', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  await stepUp(req, a, body);
  db.prepare('UPDATE games SET api_key = ? WHERE id = ?').run(newApiKey(), int(params.id));
  audit('admin', a.id, 'game.key_rotated', { ...ctxOf(req), target: params.id, severity: 'warning' });
  return gameView(db.prepare('SELECT * FROM games WHERE id = ?').get(int(params.id)), true);
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/games/:id/signing', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  await stepUp(req, a, body);
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(int(params.id));
  if (!g) throw new HttpError(404, 'Jogo não encontrado');
  let secret = null;
  if (body.regenerate || !g.signing_secret) {
    secret = 'nxs_' + require('node:crypto').randomBytes(32).toString('base64url');
    db.prepare('UPDATE games SET signing_secret = ? WHERE id = ?').run(sec.encrypt(secret), g.id);
  }
  if ('require' in body) db.prepare('UPDATE games SET require_signature = ? WHERE id = ?').run(body.require ? 1 : 0, g.id);
  audit('admin', a.id, 'game.signing_updated', { ...ctxOf(req), target: g.slug, severity: 'warning', details: { require: !!body.require, regenerated: !!secret } });
  return { ok: true, signing_secret: secret, require_signature: !!db.prepare('SELECT require_signature r FROM games WHERE id = ?').get(g.id).r };
}, { csrf: true, limit: 'sensitive' });

// ---------------------------------------------------------------- admin: produtos
const PRODUCT_TYPES = ['currency', 'skin', 'item', 'pass', 'bundle'];
function productPayload(b, ex = {}) {
  const name = str(b.name ?? ex.name, 100);
  if (!name) bad('Nome do produto é obrigatório');
  const price = int(b.price_cents ?? ex.price_cents);
  if (price == null || price < 0 || price > 10000000) bad('Preço inválido');
  return {
    game_id: int(b.game_id ?? ex.game_id), name, sku: slugify(b.sku || ex.sku || name).toUpperCase().replace(/-/g, '_').slice(0, 48),
    type: PRODUCT_TYPES.includes(b.type) ? b.type : (ex.type || 'currency'), description: str(b.description ?? ex.description, 600),
    price_cents: price, compare_cents: int(b.compare_cents ?? ex.compare_cents), coins: Math.max(0, int(b.coins ?? ex.coins, 0)),
    stock: b.stock === '' || b.stock === null ? null : int(b.stock ?? ex.stock), image_url: 'image_url' in b ? safeUrl(b.image_url) : (ex.image_url || ''),
    featured: (b.featured ?? ex.featured) ? 1 : 0, active: (b.active ?? ex.active ?? 1) ? 1 : 0,
  };
}
route('GET', '/api/admin/products', async (req, res, { query }) => {
  requireAdmin(req);
  const gid = int(query.game);
  return db.prepare(`SELECT p.*, g.name game_name,
      (SELECT COALESCE(SUM(i.qty),0) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.status IN ('paid','delivered')) sold,
      (SELECT COALESCE(SUM(i.qty*i.unit_cents),0) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.status IN ('paid','delivered')) revenue
    FROM products p JOIN games g ON g.id=p.game_id ${gid ? 'WHERE p.game_id = ?' : ''} ORDER BY g.name, p.price_cents`).all(...(gid ? [gid] : [])).map(productView);
});
route('POST', '/api/admin/products', async (req, res, { body }) => {
  const a = requireAdmin(req);
  const p = productPayload(body);
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(p.game_id)) bad('Selecione um jogo');
  if (db.prepare('SELECT 1 FROM products WHERE game_id = ? AND sku = ?').get(p.game_id, p.sku)) bad('SKU já usado neste jogo');
  const r = db.prepare(`INSERT INTO products(game_id, sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.game_id, p.sku, p.name, p.type, p.description, p.price_cents, p.compare_cents, p.coins, p.stock, p.image_url, p.featured, p.active);
  audit('admin', a.id, 'product.created', { ...ctxOf(req), target: p.sku, details: { price_cents: p.price_cents } });
  return productView(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(r.lastInsertRowid)));
}, { csrf: true });
route('PUT', '/api/admin/products/:id', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  const ex = db.prepare('SELECT * FROM products WHERE id = ?').get(int(params.id));
  if (!ex) throw new HttpError(404, 'Produto não encontrado');
  const p = productPayload(body, ex);
  if (db.prepare('SELECT 1 FROM products WHERE game_id = ? AND sku = ? AND id != ?').get(p.game_id, p.sku, ex.id)) bad('SKU já usado neste jogo');
  db.prepare(`UPDATE products SET game_id=?, sku=?, name=?, type=?, description=?, price_cents=?, compare_cents=?, coins=?, stock=?, image_url=?, featured=?, active=? WHERE id=?`)
    .run(p.game_id, p.sku, p.name, p.type, p.description, p.price_cents, p.compare_cents, p.coins, p.stock, p.image_url, p.featured, p.active, ex.id);
  if (ex.price_cents !== p.price_cents) audit('admin', a.id, 'product.price_changed', { ...ctxOf(req), target: p.sku, severity: 'warning', details: { from: ex.price_cents, to: p.price_cents } });
  return productView(db.prepare('SELECT * FROM products WHERE id = ?').get(ex.id));
}, { csrf: true });
route('DELETE', '/api/admin/products/:id', async (req, res, { params }) => {
  const a = requireAdmin(req);
  db.prepare('DELETE FROM products WHERE id = ?').run(int(params.id));
  audit('admin', a.id, 'product.deleted', { ...ctxOf(req), target: params.id });
  return { ok: true };
}, { csrf: true });

// ---------------------------------------------------------------- admin: pedidos & pagamentos
function orderFilters(query) {
  const cond = [], args = [];
  if (query.status) { cond.push('o.status = ?'); args.push(str(query.status, 20)); }
  if (query.game) { cond.push('o.game_id = ?'); args.push(int(query.game)); }
  if (query.channel) { cond.push('o.channel = ?'); args.push(str(query.channel, 20)); }
  if (query.verification) { cond.push('o.verification = ?'); args.push(str(query.verification, 20)); }
  if (query.review === '1') cond.push("o.review = 1 AND o.status IN ('pending','paid')");
  if (query.player) { cond.push('o.player_id = ?'); args.push(int(query.player)); }
  if (query.q) {
    cond.push('(o.code LIKE ? OR o.external_player_id LIKE ? OR p.username LIKE ? OR p.email LIKE ? OR o.customer_name LIKE ? OR o.payer_name LIKE ? OR o.e2e_id LIKE ? OR o.provider_payment_id LIKE ?)');
    const q = `%${str(query.q, 60)}%`; args.push(q, q, q, q, q, q, q, q);
  }
  return { sql: cond.length ? 'WHERE ' + cond.join(' AND ') : '', args };
}
route('GET', '/api/admin/orders', async (req, res, { query }) => {
  requireAdmin(req);
  const f = orderFilters(query);
  const size = Math.min(100, int(query.size, 25)), page = Math.max(1, int(query.page, 1));
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o LEFT JOIN players p ON p.id=o.player_id ${f.sql}`).get(...f.args).n;
  const rows = db.prepare(`SELECT o.id, o.code, o.game_id, o.status, o.channel, o.platform, o.payment_method, o.total_cents, o.coins_total, o.created_at, o.paid_at,
      o.external_player_id, o.customer_name, o.verification, o.review, o.risk_score, o.paid_amount_cents, o.payer_name, o.provider, o.provider_payment_id, o.e2e_id, o.player_id,
      g.name game_name, p.username, p.email
    FROM orders o JOIN games g ON g.id=o.game_id LEFT JOIN players p ON p.id=o.player_id ${f.sql}
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...f.args, size, (page - 1) * size);
  return { total, page, size, rows };
});
route('GET', '/api/admin/payments/summary', async (req, res, { query }) => {
  requireAdmin(req);
  const since = new Date(Date.now() - Math.min(365, int(query.days, 30)) * 86400000).toISOString();
  const s = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('paid','delivered') AND verification IN ('provider','game_signed') AND review = 0 THEN total_cents END),0) verified,
      COALESCE(SUM(CASE WHEN status IN ('paid','delivered') AND verification = 'manual' THEN total_cents END),0) manual,
      COALESCE(SUM(CASE WHEN status IN ('paid','delivered') AND verification IN ('game_reported','none','webhook') THEN total_cents END),0) unverified,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN total_cents END),0) pending_amount, SUM(status = 'pending') pending,
      SUM(review = 1 AND status IN ('pending','paid')) review, SUM(status = 'expired') expired,
      SUM(risk_flags LIKE '%payment_mismatch%') mismatches,
      COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_cents END),0) refunded,
      SUM(status = 'paid' AND review = 0) to_deliver
    FROM orders WHERE created_at > ?`).get(since);
  for (const k in s) s[k] = Number(s[k] || 0);
  s.provider = pay.provider();
  return s;
});
route('GET', '/api/admin/orders/:code', async (req, res, { params }) => {
  requireAdmin(req);
  const o = db.prepare(`SELECT o.*, g.name game_name, p.username, p.email, p.created_at player_since, a.name verified_by_name
    FROM orders o JOIN games g ON g.id=o.game_id LEFT JOIN players p ON p.id=o.player_id LEFT JOIN admins a ON a.id = o.verified_by WHERE o.code = ?`).get(str(params.code, 20));
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  orderWithItems(o);
  o.risk_flags = JSON.parse(o.risk_flags || '[]');
  o.events = db.prepare('SELECT at, kind, message, actor FROM order_events WHERE order_id = ? ORDER BY at, id').all(o.id);
  if (o.player_id) o.player_stats = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN total_cents END),0) spent,
      SUM(status = 'refunded') refunds FROM orders WHERE player_id = ?`).get(o.player_id);
  delete o.pix_code;
  return o;
});
const adminOrder = (req, code) => { const a = requireAdmin(req); const o = orderByCode(code); if (!o) throw new HttpError(404, 'Pedido não encontrado'); return [a, o]; };
route('POST', '/api/admin/orders/:code/verify', async (req, res, { params }) => {
  const [a, o] = adminOrder(req, params.code);
  const r = await pay.verifyWithProvider(o, 'consulta do administrador');
  audit('admin', a.id, 'payment.verify_requested', { ...ctxOf(req), target: o.code });
  return { status: r.status, provider_status: r.provider_status, verification: r.verification, review: !!r.review };
}, { csrf: true, limit: 'sensitive' });
// confirmação manual (Pix estático): exige ID E2E do comprovante + senha (+2FA)
route('POST', '/api/admin/orders/:code/confirm', async (req, res, { params, body }) => {
  const [a, o] = adminOrder(req, params.code);
  await stepUp(req, a, body);
  if (o.status !== 'pending') bad('Só pedidos aguardando pagamento podem ser confirmados');
  if (o.provider === 'mercadopago') bad('Este pedido é verificado automaticamente pelo Mercado Pago. Use "Consultar no provedor".');
  const e2e = str(body.e2e_id, 40).toUpperCase();
  if (!/^E\d{8}\d{12}[A-Z0-9]{11}$/.test(e2e)) bad('ID da transação Pix (E2E) inválido — copie do comprovante: começa com E e tem 32 caracteres');
  if (db.prepare('SELECT 1 FROM orders WHERE e2e_id = ? AND id != ?').get(e2e, o.id)) {
    audit('admin', a.id, 'payment.e2e_reuse', { ...ctxOf(req), target: o.code, severity: 'critical', details: { e2e } });
    bad('Este comprovante (E2E) já foi usado em outro pedido — possível fraude');
  }
  const amount = Math.round(Number(String(body.amount || '').replace(',', '.')) * 100);
  if (amount !== o.total_cents) bad(`O valor do comprovante (${(amount / 100).toFixed(2)}) não confere com o pedido (${(o.total_cents / 100).toFixed(2)})`);
  const r = pay.transition(o.id, 'paid', { actor: `admin:${a.name}`, message: `Pagamento conferido manualmente no extrato (E2E ${e2e})`,
    fields: { verification: 'manual', verified_by: a.id, verified_at: now(), e2e_id: e2e, paid_amount_cents: amount, payer_name: str(body.payer_name, 80) || null } });
  audit('admin', a.id, 'payment.manual_confirm', { ...ctxOf(req), target: o.code, severity: 'warning', details: { e2e, amount } });
  return { status: r.status };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/orders/:code/approve', async (req, res, { params, body }) => {
  const [a, o] = adminOrder(req, params.code);
  await stepUp(req, a, body);
  if (!o.review) bad('Este pedido não está em análise');
  if (o.status === 'paid' && !['provider', 'manual', 'game_signed', 'game_reported'].includes(o.verification)) bad('Pagamento ainda não verificado');
  db.prepare('UPDATE orders SET review = 0 WHERE id = ?').run(o.id);
  orderEvent(o.id, 'review', `Liberado após análise por ${a.name}${body.note ? ': ' + str(body.note, 200) : ''}`, `admin:${a.name}`);
  audit('admin', a.id, 'order.review_approved', { ...ctxOf(req), target: o.code, severity: 'warning' });
  pay.transition(o.id, o.status, { fields: { review: 0 } });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/orders/:code/deliver', async (req, res, { params }) => {
  const [a, o] = adminOrder(req, params.code);
  if (o.review) bad('Pedido em análise antifraude — libere antes de entregar');
  if (o.status !== 'paid') bad('Só pedidos pagos podem ser marcados como entregues');
  pay.transition(o.id, 'delivered', { actor: `admin:${a.name}`, message: `Entrega manual registrada por ${a.name}` });
  audit('admin', a.id, 'order.delivered_manual', { ...ctxOf(req), target: o.code });
  return { ok: true };
}, { csrf: true });
route('POST', '/api/admin/orders/:code/refund', async (req, res, { params, body }) => {
  const [a, o] = adminOrder(req, params.code);
  await stepUp(req, a, body);
  if (!['paid', 'delivered'].includes(o.status)) bad('Só pedidos pagos podem ser estornados');
  await pay.refund(o, `admin:${a.name}`);
  audit('admin', a.id, 'order.refunded', { ...ctxOf(req), target: o.code, severity: 'warning', details: { amount: o.total_cents } });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/orders/:code/cancel', async (req, res, { params }) => {
  const [a, o] = adminOrder(req, params.code);
  if (o.status !== 'pending') bad('Só pedidos aguardando pagamento podem ser cancelados');
  pay.transition(o.id, 'canceled', { actor: `admin:${a.name}`, message: `Cancelado por ${a.name}` });
  audit('admin', a.id, 'order.canceled', { ...ctxOf(req), target: o.code });
  return { ok: true };
}, { csrf: true });
route('POST', '/api/admin/orders', async (req, res, { body }) => {
  const a = requireAdmin(req);
  await stepUp(req, a, body);
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(int(body.game_id));
  if (!game) bad('Selecione um jogo');
  const st = ['paid', 'delivered', 'pending'].includes(body.status) ? body.status : 'paid';
  const { order } = createOrder({ game, items: body.items, channel: 'site', platform: 'web', payment_method: str(body.payment_method, 24) || 'pix', status: st,
    external_player_id: body.external_player_id, customer_name: body.customer_name, note: body.note, provider: 'admin', actor: `admin:${a.name}`,
    verification: st === 'pending' ? 'none' : 'manual', verified_by: st === 'pending' ? null : a.id, ip: req.ip });
  audit('admin', a.id, 'order.manual_created', { ...ctxOf(req), target: order.code, severity: 'warning', details: { total: order.total_cents } });
  return order;
}, { csrf: true, limit: 'sensitive' });
route('GET', '/api/admin/export/orders.csv', async (req, res, { query }) => {
  const a = requireAdmin(req);
  const f = orderFilters(query);
  const rows = db.prepare(`SELECT o.code, o.created_at, g.name game, o.channel, o.platform, o.payment_method, o.status, o.verification, o.total_cents, o.paid_amount_cents,
      o.coins_total, o.items_total, COALESCE(p.username, o.customer_name, '') cliente, COALESCE(p.email, '') email, COALESCE(o.external_player_id, '') player_id,
      COALESCE(o.payer_name, '') pagador, COALESCE(o.e2e_id, o.provider_payment_id, '') transacao, o.risk_score
    FROM orders o JOIN games g ON g.id=o.game_id LEFT JOIN players p ON p.id=o.player_id ${f.sql} ORDER BY o.created_at DESC`).all(...f.args);
  audit('admin', a.id, 'export.orders', { ...ctxOf(req), details: { rows: rows.length } });
  const head = ['pedido', 'data', 'jogo', 'canal', 'plataforma', 'pagamento', 'status', 'verificacao', 'total', 'valor_pago', 'moedas', 'itens', 'cliente', 'email', 'id_no_jogo', 'pagador', 'transacao', 'risco'];
  // prefixo ' evita injeção de fórmula no Excel (CSV injection)
  const esc = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const money = c => c == null ? '' : (c / 100).toFixed(2).replace('.', ',');
  const csv = '﻿' + [head.join(';'), ...rows.map(r => [r.code, r.created_at, r.game, r.channel, r.platform, r.payment_method, r.status, r.verification,
    money(r.total_cents), money(r.paid_amount_cents), r.coins_total, r.items_total, r.cliente, r.email, r.player_id, r.pagador, r.transacao, r.risk_score].map(esc).join(';'))].join('\n');
  return reply(200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pedidos.csv"' });
});

// ---------------------------------------------------------------- admin: jogadores
route('GET', '/api/admin/players', async (req, res, { query }) => {
  requireAdmin(req);
  const size = Math.min(100, int(query.size, 25)), page = Math.max(1, int(query.page, 1));
  const cond = [], args = [];
  if (query.q) { cond.push('(p.username LIKE ? OR p.email LIKE ? OR EXISTS (SELECT 1 FROM player_links l WHERE l.player_id = p.id AND l.external_id LIKE ?))'); const q = `%${str(query.q, 60)}%`; args.push(q, q, q); }
  if (query.game) { cond.push('p.origin_game_id = ?'); args.push(int(query.game)); }
  if (query.buyers === '1') cond.push("EXISTS (SELECT 1 FROM orders o WHERE o.player_id = p.id AND o.status IN ('paid','delivered'))");
  const w = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM players p ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT p.id, p.username, p.email, p.origin, p.country, p.created_at, p.last_seen_at, p.blocked, g.name origin_game,
      (SELECT COUNT(*) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) orders,
      (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) spent,
      (SELECT COALESCE(SUM(coins_total),0) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) coins,
      (SELECT MAX(created_at) FROM orders o WHERE o.player_id=p.id AND o.status IN ('paid','delivered')) last_purchase
    FROM players p LEFT JOIN games g ON g.id=p.origin_game_id ${w} ORDER BY ${query.sort === 'spent' ? 'spent DESC' : 'p.created_at DESC'} LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  return { total, page, size, rows };
});
route('GET', '/api/admin/players/:id', async (req, res, { params }) => {
  requireAdmin(req);
  const p = db.prepare(`SELECT p.id, p.username, p.email, p.origin, p.country, p.created_at, p.last_seen_at, p.blocked, p.signup_ip, p.last_ip, g.name origin_game
    FROM players p LEFT JOIN games g ON g.id = p.origin_game_id WHERE p.id = ?`).get(int(params.id));
  if (!p) throw new HttpError(404, 'Jogador não encontrado');
  p.links = db.prepare('SELECT l.external_id, g.name game FROM player_links l JOIN games g ON g.id = l.game_id WHERE l.player_id = ?').all(p.id);
  p.totals = db.prepare(`SELECT COUNT(*) orders, SUM(status IN ('paid','delivered')) paid_orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN total_cents END),0) spent,
      COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN coins_total END),0) coins,
      COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_cents END),0) refunded, SUM(status IN ('canceled','expired')) abandoned,
      MIN(CASE WHEN status IN ('paid','delivered') THEN created_at END) first_purchase, MAX(CASE WHEN status IN ('paid','delivered') THEN created_at END) last_purchase
    FROM orders WHERE player_id = ?`).get(p.id);
  p.by_game = db.prepare(`SELECT g.name game, g.currency_name, COUNT(*) orders, SUM(o.total_cents) spent, SUM(o.coins_total) coins FROM orders o JOIN games g ON g.id = o.game_id
    WHERE o.player_id = ? AND o.status IN ('paid','delivered') GROUP BY g.id ORDER BY spent DESC`).all(p.id);
  p.orders = db.prepare(`SELECT o.code, o.status, o.total_cents, o.coins_total, o.created_at, o.verification, o.review, o.channel, g.name game
    FROM orders o JOIN games g ON g.id = o.game_id WHERE o.player_id = ? ORDER BY o.created_at DESC LIMIT 50`).all(p.id);
  p.same_ip_accounts = p.signup_ip ? db.prepare('SELECT COUNT(*) n FROM players WHERE signup_ip = ? AND id != ?').get(p.signup_ip, p.id).n : 0;
  return p;
});
route('POST', '/api/admin/players/:id/block', async (req, res, { params, body }) => {
  const a = requireAdmin(req);
  const block = body.block ? 1 : 0;
  db.prepare('UPDATE players SET blocked = ? WHERE id = ?').run(block, int(params.id));
  if (block) db.prepare("DELETE FROM sessions WHERE kind = 'player' AND subject_id = ?").run(int(params.id));
  audit('admin', a.id, block ? 'player.blocked' : 'player.unblocked', { ...ctxOf(req), target: params.id, severity: 'warning' });
  return { ok: true };
}, { csrf: true });

// ---------------------------------------------------------------- admin: configurações
const PLAIN = ['store_name', 'support_email', 'pix_key', 'pix_name', 'pix_city', 'public_url', 'payment_provider'];
const SECRET = ['mp_access_token', 'mp_webhook_secret', 'webhook_secret'];
const PAYMENT_KEYS = ['pix_key', 'payment_provider', 'mp_access_token', 'mp_webhook_secret', 'webhook_secret', 'public_url'];
route('GET', '/api/admin/settings', async req => {
  requireAdmin(req);
  const out = Object.fromEntries(PLAIN.map(k => [k, getSetting(k) || '']));
  for (const k of SECRET) { const v = sec.decrypt(getSetting(k) || ''); out[k + '_set'] = !!v; out[k + '_hint'] = v ? sec.mask(v, 4) : ''; }
  out.provider_active = pay.provider();
  out.webhook_url = (getSetting('public_url') || '').replace(/\/$/, '') + '/api/webhooks/mercadopago';
  return out;
});
route('PUT', '/api/admin/settings', async (req, res, { body }) => {
  const a = requireAdmin(req);
  const touchesPayment = PAYMENT_KEYS.some(k => k in body && (SECRET.includes(k) ? !!body[k] : str(body[k], 300) !== (getSetting(k) || '')));
  if (touchesPayment) await stepUp(req, a, body);
  const changed = [];
  for (const k of PLAIN) if (k in body) {
    let v = str(body[k], 300);
    if (k === 'public_url' && v) v = safeUrl(v);
    if (k === 'payment_provider' && !['manual_pix', 'mercadopago'].includes(v)) v = 'manual_pix';
    if ((getSetting(k) || '') !== v) { setSetting(k, v); changed.push(k); }
  }
  for (const k of SECRET) if (k in body && body[k]) { setSetting(k, sec.encrypt(str(body[k], 400))); changed.push(k); }
  if (changed.length) audit('admin', a.id, 'settings.changed', { ...ctxOf(req), severity: changed.some(k => PAYMENT_KEYS.includes(k)) ? 'critical' : 'info', details: { keys: changed } });
  return { ok: true, changed };
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/settings/test-provider', async (req, res) => {
  requireAdmin(req);
  if (pay.provider() !== 'mercadopago') bad('Configure o Mercado Pago primeiro');
  try {
    const r = await fetch((process.env.MP_API_BASE || 'https://api.mercadopago.com') + '/users/me', { headers: { Authorization: 'Bearer ' + sec.decrypt(getSetting('mp_access_token')) }, signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) bad('Token recusado pelo Mercado Pago: ' + (d.message || r.status));
    return { ok: true, account: d.nickname || d.email || d.id, live: !String(sec.decrypt(getSetting('mp_access_token'))).startsWith('TEST-') };
  } catch (e) { if (e instanceof HttpError) throw e; bad('Não foi possível conectar ao Mercado Pago'); }
}, { csrf: true, limit: 'sensitive' });
route('POST', '/api/admin/demo', async (req, res, { body }) => {
  const a = requireAdmin(req);
  if (sec.PROD && process.env.ALLOW_DEMO !== '1') throw new HttpError(403, 'Dados de demonstração desativados em produção');
  await stepUp(req, a, body);
  require('./seed').seed();
  audit('admin', a.id, 'data.demo_generated', { ...ctxOf(req), severity: 'critical' });
  return { ok: true };
}, { csrf: true, limit: 'sensitive' });

// ---------------------------------------------------------------- API dos jogos (v1)
function requireGame(req, raw) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '');
  const game = key && key.length < 100 && db.prepare('SELECT * FROM games WHERE api_key = ?').get(key);
  if (!game) { audit('anon', null, 'api.bad_key', { ip: req.ip, severity: 'warning' }); throw new HttpError(401, 'API key inválida'); }
  const wait = sec.take('api', 'k' + game.id, req.ip);
  if (wait) throw new HttpError(429, 'Limite de requisições excedido', { retry: wait });
  let signed = false;
  if (req.headers['x-nexus-signature'] || game.require_signature) {
    const err = game.signing_secret ? sec.verifyGameSignature(req, raw, sec.decrypt(game.signing_secret)) : 'Jogo sem segredo de assinatura configurado';
    if (err) { audit('game', game.id, 'api.signature_rejected', { ip: req.ip, severity: 'critical', details: { reason: err, path: req.url.slice(0, 120) } }); throw new HttpError(401, err); }
    signed = true;
  }
  game.signed = signed;
  return game;
}
const playerByExternal = (game, ext) => db.prepare('SELECT p.* FROM player_links l JOIN players p ON p.id=l.player_id WHERE l.game_id = ? AND l.external_id = ?').get(game.id, ext);
route('GET', '/api/v1/catalog', async (req, res, { raw }) => {
  const g = requireGame(req, raw);
  return {
    game: { id: g.id, slug: g.slug, name: g.name, currency_name: g.currency_name },
    products: db.prepare(`SELECT sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured FROM products WHERE game_id = ? AND active = 1 ORDER BY price_cents`).all(g.id).map(p => ({ ...p, featured: !!p.featured })),
  };
}, { auth: 'game' });
route('POST', '/api/v1/players', async (req, res, { body, raw }) => {
  const g = requireGame(req, raw);
  const ext = str(body.external_id, 80);
  if (!/^[\w.\-:@]{1,80}$/.test(ext)) bad('external_id inválido');
  let p = playerByExternal(g, ext);
  if (!p) {
    let username = slugify(body.username || `${g.slug}-${ext}`).slice(0, 32) || `player-${ext}`;
    if (db.prepare('SELECT 1 FROM players WHERE username = ?').get(username)) username = `${username}-${require('node:crypto').randomBytes(2).toString('hex')}`;
    const r = db.prepare(`INSERT INTO players(username, origin, origin_game_id, country, last_seen_at) VALUES (?, 'game', ?, ?, ?)`).run(username, g.id, str(body.country, 2).toUpperCase() || 'BR', now());
    db.prepare('INSERT INTO player_links(player_id, game_id, external_id) VALUES (?,?,?)').run(Number(r.lastInsertRowid), g.id, ext);
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(r.lastInsertRowid));
    track({ type: 'signup', game_id: g.id, player_id: p.id, platform: body.platform, country: body.country });
    return reply(201, { player_id: p.id, username: p.username, created: true });
  }
  db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now(), p.id);
  return { player_id: p.id, username: p.username, created: false };
}, { auth: 'game' });
route('POST', '/api/v1/events', async (req, res, { body, raw }) => {
  const g = requireGame(req, raw);
  const list = Array.isArray(body.events) ? body.events.slice(0, 200) : [body];
  tx(() => {
    for (const e of list) {
      const p = e.external_id ? playerByExternal(g, str(e.external_id, 80)) : null;
      if (p) db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now(), p.id);
      track({ type: e.type, game_id: g.id, player_id: p?.id ?? null, visitor_id: e.external_id, platform: e.platform, country: e.country });
    }
  });
  return { ok: true, accepted: list.length };
}, { auth: 'game' });
route('POST', '/api/v1/purchases', async (req, res, { body, raw }) => {
  const g = requireGame(req, raw);
  const ext = str(body.external_id, 80);
  if (!ext) bad('external_id é obrigatório');
  const p = playerByExternal(g, ext);
  const paid = body.status === 'paid';
  if (paid && !str(body.external_ref, 120)) bad('Compras pagas precisam do external_ref (ID do recibo da loja) para evitar duplicidade');
  const r = createOrder({ game: g, items: body.items, channel: 'in_game', platform: body.platform || 'pc', payment_method: body.payment_method || 'store',
    status: paid ? 'paid' : 'pending', player_id: p?.id, external_player_id: ext, external_ref: body.external_ref, ip: req.ip,
    provider: paid ? 'store' : null, verification: paid ? (g.signed ? 'game_signed' : 'game_reported') : 'none', actor: `jogo:${g.slug}` });
  let order = r.order, charge = null;
  if (!r.duplicate && !paid) charge = await pay.createCharge(order, {});
  return reply(r.duplicate ? 200 : 201, { order: publicOrder(order), pix: charge?.pix || null, expires_at: charge?.expires_at || null, duplicate: !!r.duplicate });
}, { auth: 'game' });
route('GET', '/api/v1/purchases/:code', async (req, res, { params, raw }) => {
  const g = requireGame(req, raw);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND game_id = ?').get(str(params.code, 20), g.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return publicOrder(orderWithItems(o));
}, { auth: 'game' });
// só entrega pedidos PAGOS, VERIFICADOS e fora de análise antifraude
route('GET', '/api/v1/deliveries', async (req, res, { query, raw }) => {
  const g = requireGame(req, raw);
  const ext = str(query.external_id, 80);
  if (!ext) bad('external_id é obrigatório');
  return db.prepare(`SELECT * FROM orders WHERE game_id = ? AND status = 'paid' AND review = 0 AND external_player_id = ?
      AND verification IN ('provider','manual','game_signed','game_reported','webhook') ORDER BY created_at`)
    .all(g.id, ext).map(o => publicOrder(orderWithItems(o)));
}, { auth: 'game' });
route('POST', '/api/v1/deliveries/:code/ack', async (req, res, { params, raw }) => {
  const g = requireGame(req, raw);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND game_id = ?').get(str(params.code, 20), g.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (o.status === 'delivered') return publicOrder(orderWithItems(o));
  if (o.status !== 'paid' || o.review) bad('Pedido não liberado para entrega');
  const up = pay.transition(o.id, 'delivered', { actor: `jogo:${g.slug}`, message: `Itens creditados no jogo (confirmação ${g.signed ? 'assinada' : 'por chave'})` });
  return publicOrder(orderWithItems(up));
}, { auth: 'game' });

// ---------------------------------------------------------------- webhooks
route('POST', '/api/webhooks/mercadopago', async (req, res, { query, body }) => {
  await pay.handleMpWebhook(req, query, body, req.ip);
  return { ok: true };
}, { auth: 'none', limit: 'webhook' });
// webhook genérico (automação própria): corpo assinado com HMAC-SHA256 + timestamp
route('POST', '/api/webhooks/payment', async (req, res, { body, raw }) => {
  const secret = sec.decrypt(getSetting('webhook_secret') || '');
  const ts = Number(req.headers['x-nexus-timestamp']);
  const sig = String(req.headers['x-nexus-signature'] || '');
  if (!secret || !ts || Math.abs(Date.now() / 1000 - ts) > 300 || !sec.safeEqual(sec.hmac(secret, `${ts}.${raw}`), sig)) {
    audit('system', null, 'webhook.rejected', { ip: req.ip, severity: 'critical', details: { endpoint: 'payment' } });
    throw new HttpError(401, 'Assinatura inválida');
  }
  const o = orderByCode(body.code);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (body.amount_cents != null && int(body.amount_cents) !== o.total_cents) {
    audit('system', null, 'payment.mismatch', { target: o.code, severity: 'critical', details: { got: body.amount_cents, expected: o.total_cents } });
    bad('Valor divergente');
  }
  const up = pay.transition(o.id, 'paid', { actor: 'webhook', message: 'Pagamento confirmado por webhook assinado', fields: { verification: 'webhook', verified_at: now(), paid_amount_cents: o.total_cents, e2e_id: str(body.e2e_id, 40) || null } });
  return publicOrder(orderWithItems(up));
}, { auth: 'none', limit: 'webhook' });

// ---------------------------------------------------------------- público (site)
route('GET', '/api/public/info', () => ({ store_name: getSetting('store_name') || 'NEXUS', support_email: getSetting('support_email') || '', expire_min: pay.EXPIRE_MIN }));
route('GET', '/api/public/market', async () => ({
  games: db.prepare(`SELECT id, slug, name, accent, currency_name, genre, status FROM games WHERE status != 'paused' ORDER BY created_at`).all(),
  products: db.prepare(`SELECT p.id, p.sku, p.name, p.type, p.description, p.price_cents, p.compare_cents, p.coins, p.stock, p.image_url, p.featured, p.game_id,
      (SELECT COALESCE(SUM(i.qty),0) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = p.id AND o.status IN ('paid','delivered') AND o.created_at > ?) sold_30d
    FROM products p JOIN games g ON g.id = p.game_id WHERE p.active = 1 AND g.status != 'paused' ORDER BY p.featured DESC, p.price_cents`).all(new Date(Date.now() - 30 * 86400000).toISOString()).map(productView),
}));
route('GET', '/api/public/games', () =>
  db.prepare(`SELECT g.*, (SELECT MIN(price_cents) FROM products p WHERE p.game_id=g.id AND p.active=1) min_price,
      (SELECT COUNT(*) FROM events e WHERE e.game_id=g.id AND e.type='download') downloads
    FROM games g WHERE g.status != 'paused' ORDER BY g.created_at`).all().map(g => gameView(g)));
route('GET', '/api/public/games/:slug', async (req, res, { params }) => {
  const g = db.prepare(`SELECT * FROM games WHERE slug = ? AND status != 'paused'`).get(str(params.slug, 80));
  if (!g) throw new HttpError(404, 'Jogo não encontrado');
  const products = db.prepare(`SELECT id, sku, name, type, description, price_cents, compare_cents, coins, stock, image_url, featured
    FROM products WHERE game_id = ? AND active = 1 ORDER BY featured DESC, price_cents`).all(g.id).map(productView);
  const downloads = db.prepare(`SELECT COUNT(*) n FROM events WHERE game_id = ? AND type='download'`).get(g.id).n;
  return { game: { ...gameView(g), downloads }, products };
});
route('POST', '/api/public/track', async (req, res, { body }) => {
  if (!['page_view', 'download'].includes(body.type)) bad('Tipo inválido');
  const g = body.game ? db.prepare('SELECT id FROM games WHERE slug = ?').get(str(body.game, 80)) : null;
  const ps = sessionOf(req, 'player');
  const ua = req.headers['user-agent'] || '';
  if (/bot|crawl|spider|headless/i.test(ua)) return { ok: true };
  const platform = /android/i.test(ua) ? 'android' : /iphone|ipad/i.test(ua) ? 'ios' : 'pc';
  track({ type: body.type, game_id: g?.id ?? null, player_id: ps?.id ?? null, visitor_id: body.visitor, platform, country: 'BR', path: body.path });
  return { ok: true };
}, { csrf: true });
route('GET', '/api/public/me', async req => {
  const s = sessionOf(req, 'player');
  if (!s) return { player: null };
  const player = db.prepare('SELECT id, username, display_name, email, email_verified, created_at FROM players WHERE id = ? AND blocked = 0').get(s.id);
  if (!player) return { player: null };
  const links = db.prepare('SELECT l.game_id, l.external_id, g.slug, g.name FROM player_links l JOIN games g ON g.id=l.game_id WHERE l.player_id = ?').all(s.id);
  const orders = db.prepare(`SELECT o.code, o.status, o.review, o.total_cents, o.coins_total, o.created_at, o.external_player_id, g.name game
    FROM orders o JOIN games g ON g.id=o.game_id WHERE o.player_id = ? ORDER BY o.created_at DESC LIMIT 50`).all(s.id).map(o => ({ ...o, in_review: !!o.review }));
  return { player: { ...player, email_verified: !!player.email_verified }, links, orders };
});
route('POST', '/api/public/checkout', async (req, res, { body }) => {
  const p = requirePlayer(req);
  if (!p.email_verified) throw new HttpError(403, 'Confirme seu e-mail antes de comprar (enviamos um link para a sua caixa de entrada).');
  const game = db.prepare(`SELECT * FROM games WHERE slug = ? AND status != 'paused'`).get(str(body.game, 80));
  if (!game) bad('Jogo não encontrado');
  const ext = str(body.external_id, 80);
  if (!/^[\w.\-:@]{2,80}$/.test(ext)) bad('Informe um ID de jogador válido');
  const pending = db.prepare(`SELECT COUNT(*) n FROM orders WHERE player_id = ? AND status = 'pending'`).get(p.id).n;
  if (pending >= MAX_PENDING_PER_PLAYER) bad(`Você já tem ${pending} pagamentos em aberto. Pague ou aguarde expirarem (${pay.EXPIRE_MIN} min).`);
  if (!db.prepare('SELECT 1 FROM player_links WHERE game_id = ? AND external_id = ?').get(game.id, ext))
    db.prepare('INSERT INTO player_links(player_id, game_id, external_id) VALUES (?,?,?)').run(p.id, game.id, ext);
  db.prepare('UPDATE players SET last_ip = ? WHERE id = ?').run(req.ip, p.id);
  const { order } = createOrder({ game, items: body.items, channel: 'site', platform: 'web', payment_method: 'pix', status: 'pending', player_id: p.id,
    external_player_id: ext, customer_name: p.username, customer_contact: p.email, note: body.note, ip: req.ip, ua: req.headers['user-agent'], actor: `jogador:${p.username}` });
  let charge;
  try { charge = await pay.createCharge(order, { email: p.email, name: p.username }); }
  catch (e) {
    pay.transition(order.id, 'canceled', { message: 'Falha ao gerar cobrança no provedor: ' + e.message });
    audit('system', null, 'payment.charge_failed', { target: order.code, severity: 'critical', details: { error: e.message } });
    throw new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }
  return reply(201, { order: publicOrder({ ...order, expires_at: charge.expires_at }), pix: charge.pix, expires_at: charge.expires_at, automatic: charge.provider === 'mercadopago' });
}, { limit: 'sensitive', csrf: true });
route('GET', '/api/public/orders/:code', async (req, res, { params }) => {
  const p = requirePlayer(req);
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND player_id = ?').get(str(params.code, 20), p.id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  return publicOrder(orderWithItems(o));
});

// ============================================================ estáticos
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/' || pathname === '/index.html') file = 'index.html';
  else if (/^\/admin\/?$/.test(pathname)) file = 'admin/index.html';
  else if (/^\/jogo\/[^/]+\/?$/.test(pathname)) file = 'game.html';
  else if (/^\/conta\/?$/.test(pathname)) file = 'account.html';
  else if (/^\/mercado\/?$/.test(pathname)) file = 'market.html';
  else file = pathname.slice(1);
  if (file.split('/').some(seg => seg.startsWith('.'))) return send(res, 404, 'Não encontrado');
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Proibido');
  fs.readFile(full, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC, '404.html'), (e2, d2) => send(res, 404, e2 ? 'Não encontrado' : d2, { 'Content-Type': MIME['.html'] }));
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ============================================================ servidor
const server = http.createServer(async (req, res) => {
  // verificação de saúde do provedor de hospedagem (Render etc.)
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  req.ip = sec.clientIp(req);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'URL inválida'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'URL inválida'); }
  const isApi = pathname.startsWith('/api/');
  sec.securityHeaders(req, res, { api: isApi });
  if (sec.isBlocked(req.ip)) return send(res, 403, { error: 'Acesso temporariamente bloqueado por atividade suspeita.' });
  if (process.env.FORCE_HTTPS === '1' && !sec.isHttps(req)) return send(res, 301, '', { Location: 'https://' + req.headers.host + req.url });

  if (pathname.startsWith('/api/v1/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key, X-Nexus-Timestamp, X-Nexus-Signature');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204, '');
  }
  if (!isApi) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
    const w = sec.take('public', req.ip, req.ip); if (w) return send(res, 429, 'Muitas requisições', { 'Retry-After': String(w) });
    return serveStatic(req, res, pathname);
  }
  const r = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!r) return send(res, 404, { error: 'Rota não encontrada' });
  try {
    if (r.opts.auth !== 'game') {
      const kind = r.opts.limit || (pathname.startsWith('/api/admin/') ? 'admin' : 'public');
      const wait = sec.take(kind, req.ip, req.ip);
      if (wait) throw new HttpError(429, 'Muitas tentativas. Aguarde um pouco.', { retry: wait });
    }
    // CSRF: rotas com cookie que alteram estado exigem origem igual + cabeçalho próprio
    if (req.method !== 'GET' && r.opts.auth !== 'game' && r.opts.auth !== 'none' && !sec.csrfOk(req)) {
      audit('anon', null, 'csrf.blocked', { ip: req.ip, target: pathname, severity: 'warning' });
      throw new HttpError(403, 'Requisição bloqueada (origem não confirmada)');
    }
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const { raw, body } = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : { raw: '', body: {} };
    const out = await r.handler(req, res, { params, body, raw, query: Object.fromEntries(url.searchParams) });
    if (out === null) return;
    if (out && out[REPLY]) return send(res, out.status, out.body, out.headers);
    send(res, 200, out);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof HttpError || e.status ? e.message : 'Erro interno' }, e.extra?.retry ? { 'Retry-After': String(e.extra.retry) } : {});
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;

function listen() {
  pay.startJobs();
  cloud.start(db, DB_FILE);
  // limpeza periódica de sessões vencidas
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600000).unref();
  // desligamento gracioso (Render/hospedagens enviam SIGTERM): salva a última cópia antes de sair
  let closing = false;
  const shutdown = async sig => {
    if (closing) return; closing = true;
    console.log(`\n[${sig}] encerrando…`);
    server.close();
    for (const res of streams) res.end();
    await cloud.snapshot(db, DB_FILE).catch(() => { });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  server.listen(PORT, () => {
    console.log(`\n  NEXUS rodando em http://localhost:${PORT}`);
    console.log(`  Site:   http://localhost:${PORT}/`);
    console.log(`  Painel: http://localhost:${PORT}/admin`);
    console.log(`  Pagamento: ${pay.provider() === 'mercadopago' ? 'Mercado Pago (verificação automática)' : 'Pix manual (conferência no painel)'}`);
    console.log(`  Backup na nuvem: ${cloud.enabled() ? 'ativo (Firestore)' : 'desativado'}\n`);
  });
}
if (require.main === module) listen();
module.exports = { server, listen };
