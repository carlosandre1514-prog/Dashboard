// Persistência para hospedagem gratuita (Render free etc.), onde o disco é apagado a cada reinício.
// O banco SQLite é salvo no Firestore do seu Firebase (plano grátis): cópia consistente (VACUUM INTO),
// compactada (gzip), CRIPTOGRAFADA (AES-256-GCM com a APP_SECRET) e dividida em pedaços de 700 KB.
// Ao iniciar sem banco local, o servidor baixa, confere (SHA-256) e restaura a última cópia.
//
// Ativação: variável FIREBASE_SERVICE_ACCOUNT com o JSON da conta de serviço (Firebase → Configurações
// do projeto → Contas de serviço → Gerar nova chave privada) + APP_SECRET fixa.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CHUNK = 700 * 1024;
const COLLECTION = process.env.BACKUP_COLLECTION || 'nexus_backup';

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  let txt = raw.trim();
  if (!txt.startsWith('{')) txt = Buffer.from(txt, 'base64').toString('utf8'); // aceita JSON puro ou base64
  const sa = JSON.parse(txt);
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT incompleta');
  return sa;
}
const enabled = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;

// ---------- token OAuth da conta de serviço (JWT RS256) ----------
let tok = { value: null, until: 0 };
async function accessToken(sa) {
  if (tok.value && Date.now() < tok.until) return tok.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const jwt = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }), signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Falha ao autenticar a conta de serviço: ' + (d.error_description || d.error || r.status));
  tok = { value: d.access_token, until: Date.now() + (Number(d.expires_in || 3600) - 300) * 1000 };
  return tok.value;
}

async function fs_(sa, method, doc, body) {
  const base = process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
  const url = `${base}/projects/${sa.project_id}/databases/(default)/documents/${COLLECTION}/${doc}`;
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + await accessToken(sa), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  if (method === 'GET' && r.status === 404) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Firestore ${method} ${doc}: ${d.error?.message || r.status}`);
  return d;
}

// ---------- criptografia da cópia ----------
const keyOf = () => {
  if (!process.env.APP_SECRET) throw new Error('Defina APP_SECRET para usar o backup na nuvem');
  return crypto.createHash('sha256').update('nexus-backup|' + process.env.APP_SECRET).digest();
};
function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function open(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// ---------- restauração (antes de abrir o banco) ----------
async function restoreIfNeeded(dbFile) {
  if (!enabled()) return { skipped: 'desativado' };
  if (fs.existsSync(dbFile)) return { skipped: 'banco local já existe' };
  const sa = serviceAccount();
  const man = await fs_(sa, 'GET', 'manifest');
  if (!man) return { skipped: 'nenhuma cópia na nuvem ainda' };
  const f = man.fields;
  const slot = f.slot.stringValue, chunks = Number(f.chunks.integerValue), sha = f.sha256.stringValue;
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    const doc = await fs_(sa, 'GET', `${slot}_${i}`);
    if (!doc) throw new Error(`Pedaço ${slot}_${i} ausente`);
    parts.push(Buffer.from(doc.fields.data.bytesValue, 'base64'));
  }
  const sealed = Buffer.concat(parts);
  if (crypto.createHash('sha256').update(sealed).digest('hex') !== sha) throw new Error('Cópia corrompida (SHA-256 não confere)');
  const raw = zlib.gunzipSync(open(sealed));
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile + '.restore', raw, { mode: 0o600 });
  fs.renameSync(dbFile + '.restore', dbFile);
  return { restored: true, bytes: raw.length, at: f.at.stringValue };
}

// ---------- envio de cópias ----------
let state = { running: false, pending: false, lastChanges: -1, timer: null, last: null, lastError: null, slot: null };
async function snapshot(db, dbFile, { force = false } = {}) {
  if (!enabled()) return null;
  const changes = db.prepare('SELECT total_changes() c').get().c;
  if (!force && changes === state.lastChanges) return null;
  if (state.running) { state.pending = true; return null; }
  state.running = true;
  const tmp = dbFile + '.snap';
  try {
    const sa = serviceAccount();
    if (state.slot === null) { const m = await fs_(sa, 'GET', 'manifest'); state.slot = m?.fields?.slot?.stringValue || 'B'; }
    try { fs.unlinkSync(tmp); } catch { }
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // cópia consistente, mesmo com escritas em andamento
    const sealed = seal(zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
    const slot = state.slot === 'A' ? 'B' : 'A'; // escreve no slot inativo; o manifesto só troca no fim
    const n = Math.ceil(sealed.length / CHUNK);
    for (let i = 0; i < n; i++) await fs_(sa, 'PATCH', `${slot}_${i}`, { fields: { data: { bytesValue: sealed.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64') } } });
    const at = new Date().toISOString();
    await fs_(sa, 'PATCH', 'manifest', { fields: {
      slot: { stringValue: slot }, chunks: { integerValue: String(n) }, sha256: { stringValue: crypto.createHash('sha256').update(sealed).digest('hex') },
      size: { integerValue: String(sealed.length) }, at: { stringValue: at },
    } });
    state.slot = slot; state.lastChanges = changes; state.last = { at, bytes: sealed.length, chunks: n }; state.lastError = null;
    return state.last;
  } catch (e) {
    state.lastError = { at: new Date().toISOString(), message: e.message };
    console.error('[backup] falhou:', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
    state.running = false;
    if (state.pending) { state.pending = false; soon(db, dbFile); }
  }
}
// pedidos e pagamentos: salva em poucos segundos; resto: a cada BACKUP_INTERVAL_SEC
let ref = null;
function soon(db = ref?.db, dbFile = ref?.dbFile) {
  if (!enabled() || !db) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => snapshot(db, dbFile), 4000);
}
function start(db, dbFile) {
  if (!enabled()) return;
  ref = { db, dbFile };
  state.lastChanges = db.prepare('SELECT total_changes() c').get().c; // recém-restaurado = já está na nuvem
  const every = Math.max(60, Number(process.env.BACKUP_INTERVAL_SEC || 300)) * 1000;
  setInterval(() => snapshot(db, dbFile), every).unref();
}
const status = () => ({ enabled: enabled(), last: state.last, error: state.lastError });

module.exports = { enabled, restoreIfNeeded, snapshot, soon, start, status };
