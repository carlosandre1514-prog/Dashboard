// Banco de dados SQLite nativo do Node (node:sqlite) — sem dependências externas.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
process.removeAllListeners('warning'); // silencia o aviso "experimental" do node:sqlite
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'nexus.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'admin' | 'player'
  subject_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  description TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'live',      -- live | beta | dev | paused
  version TEXT DEFAULT '1.0.0',
  platforms TEXT DEFAULT 'pc',              -- csv: pc,android,ios,web
  download_url TEXT DEFAULT '',
  cover_url TEXT DEFAULT '',
  accent TEXT DEFAULT '#3987e5',
  currency_name TEXT DEFAULT 'Moedas',
  api_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'currency',    -- currency | skin | item | pass | bundle
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL,
  compare_cents INTEGER,
  coins INTEGER NOT NULL DEFAULT 0,         -- moedas entregues (pacotes de moeda)
  stock INTEGER,                            -- NULL = ilimitado
  image_url TEXT DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (game_id, sku)
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  pass_hash TEXT,
  origin TEXT NOT NULL DEFAULT 'site',      -- site | game
  origin_game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  country TEXT DEFAULT 'BR',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

-- vínculo entre a conta do site e o ID do jogador dentro de cada jogo
CREATE TABLE IF NOT EXISTS player_links (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  PRIMARY KEY (game_id, external_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  external_player_id TEXT,                  -- ID do jogador no jogo (quem recebe)
  external_ref TEXT,                        -- ID da transação na loja do jogo (Google Play, Steam...)
  channel TEXT NOT NULL DEFAULT 'site',     -- site | in_game
  platform TEXT NOT NULL DEFAULT 'web',     -- web | pc | android | ios
  payment_method TEXT NOT NULL DEFAULT 'pix',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | delivered | refunded | canceled
  total_cents INTEGER NOT NULL,
  coins_total INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  customer_contact TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0
);

-- telemetria: acessos ao site, sessões no jogo, downloads, instalações, cadastros
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                       -- page_view | download | install | session_start | signup
  game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER,
  visitor_id TEXT,
  platform TEXT,
  country TEXT,
  path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS ix_orders_game ON orders(game_id, created_at);
CREATE INDEX IF NOT EXISTS ix_events_created ON events(type, created_at);
CREATE INDEX IF NOT EXISTS ix_events_game ON events(game_id, type, created_at);
CREATE INDEX IF NOT EXISTS ix_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS ix_players_created ON players(created_at);
`);

// ---------- migrações (colunas novas em bancos existentes) ----------
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, def] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumns('admins', [
  ['totp_secret', 'TEXT'], ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['totp_last', 'INTEGER NOT NULL DEFAULT -1'],
  ['recovery_codes', 'TEXT'], ['firebase_uid', 'TEXT'], ['role', "TEXT NOT NULL DEFAULT 'admin'"], ['failed_logins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT'], ['last_login_at', 'TEXT'], ['last_login_ip', 'TEXT'],
]);
addColumns('players', [['firebase_uid', 'TEXT'], ['email_verified', 'INTEGER NOT NULL DEFAULT 0'], ['display_name', 'TEXT'], ['failed_logins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT'], ['signup_ip', 'TEXT'], ['last_ip', 'TEXT'], ['blocked', 'INTEGER NOT NULL DEFAULT 0']]);
addColumns('games', [['signing_secret', 'TEXT'], ['require_signature', 'INTEGER NOT NULL DEFAULT 0']]);
addColumns('orders', [
  ['provider', "TEXT"],                  // mercadopago | manual_pix | store | admin
  ['provider_payment_id', 'TEXT'], ['provider_status', 'TEXT'],
  ['paid_amount_cents', 'INTEGER'], ['net_amount_cents', 'INTEGER'],
  ['payer_name', 'TEXT'], ['payer_email', 'TEXT'], ['payer_doc', 'TEXT'], ['e2e_id', 'TEXT'],
  ['verification', "TEXT NOT NULL DEFAULT 'none'"], // provider | manual | game_signed | game_reported | none
  ['verified_by', 'INTEGER'], ['verified_at', 'TEXT'],
  ['risk_score', 'INTEGER NOT NULL DEFAULT 0'], ['risk_flags', 'TEXT'], ['review', 'INTEGER NOT NULL DEFAULT 0'],
  ['expires_at', 'TEXT'], ['ip', 'TEXT'], ['user_agent', 'TEXT'], ['pix_code', 'TEXT'],
]);
// sessões antigas (token em texto) são descartadas: agora só o hash do token é guardado
if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'token_hash')) {
  db.exec(`DROP TABLE IF EXISTS sessions;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT
    );`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL, message TEXT, actor TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS ix_order_events ON order_events(order_id, at);
-- auditoria encadeada por hash (qualquer alteração quebra a cadeia)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  target TEXT, ip TEXT, user_agent TEXT, severity TEXT NOT NULL DEFAULT 'info', details TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_players_fb ON players(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_orders_provider ON orders(provider_payment_id);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS ix_orders_player ON orders(player_id, created_at);
`);

// ---------- helpers ----------
const crypto = require('node:crypto');
const newApiKey = () => 'nx_live_' + crypto.randomBytes(24).toString('base64url');
const newToken = () => crypto.randomBytes(32).toString('base64url');
function orderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(8)) s += alphabet[b % alphabet.length];
  return 'NX-' + s.slice(0, 4) + '-' + s.slice(4);
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

module.exports = { db, tx, newApiKey, newToken, orderCode, getSetting, setSetting, DATA_DIR };
