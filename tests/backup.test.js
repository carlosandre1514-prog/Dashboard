// Backup na nuvem: salva o banco no "Firestore" (simulado), apaga o disco e restaura em outro processo.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const run = (code, env) => new Promise(res => execFile(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout + stderr })));

const store = new Map();
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: { message: 'unauth' } });
    const m = decodeURIComponent(req.url).match(/\/documents\/nexus_backup\/(.+)$/);
    if (!m) return json(404, {});
    if (req.method === 'GET') return store.has(m[1]) ? json(200, store.get(m[1])) : json(404, { error: { message: 'not found' } });
    if (req.method === 'PATCH') { store.set(m[1], JSON.parse(body)); return json(200, store.get(m[1])); }
    json(405, {});
  });
});

let env;
test.before(async () => {
  await new Promise(r => fake.listen(0, r));
  const port = fake.address().port;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  env = {
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p', client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${port}/token` }),
    FIRESTORE_BASE: `http://127.0.0.1:${port}/v1`, APP_SECRET: 'segredo-fixo', ADMIN_EMAILS: '',
  };
});
test.after(() => fake.close());

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-a-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-b-'));
const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-c-'));

test('salva cópia criptografada do banco na nuvem', async () => {
  const r = await run(`
    const { db, DB_FILE, setSetting } = require('./server/db');
    setSetting('pix_key', 'chave-secreta-de-teste@pix.com');
    db.prepare("INSERT INTO games(slug, name, api_key) VALUES ('jogo-x', 'Jogo X', 'k1')").run();
    require('./server/cloudbackup').snapshot(db, DB_FILE, { force: true }).then(r => { console.log(JSON.stringify(r)); process.exit(r ? 0 : 1); });
  `, { ...env, DATA_DIR: dirA });
  assert.equal(r.code, 0, r.out);
  assert.ok(store.has('manifest'));
  const all = [...store.values()].map(d => JSON.stringify(d)).join('');
  for (const d of store.values()) if (d.fields.data) assert.ok(!Buffer.from(d.fields.data.bytesValue, 'base64').toString('latin1').includes('chave-secreta'), 'dados não podem ir em texto');
  assert.ok(!all.includes('Jogo X'));
});

test('servidor novo (disco vazio) restaura tudo da nuvem', async () => {
  const r = await run(`
    const cloud = require('./server/cloudbackup');
    const path = require('path');
    cloud.restoreIfNeeded(path.join(process.env.DATA_DIR, 'nexus.db')).then(res => {
      const { db, getSetting } = require('./server/db');
      console.log(JSON.stringify({ res, pix: getSetting('pix_key'), game: db.prepare('SELECT name FROM games').get()?.name }));
    });
  `, { ...env, DATA_DIR: dirB });
  assert.equal(r.code, 0, r.out);
  const out = JSON.parse(r.out.trim().split('\n').pop());
  assert.equal(out.res.restored, true);
  assert.equal(out.pix, 'chave-secreta-de-teste@pix.com');
  assert.equal(out.game, 'Jogo X');
});

test('cópia não abre com APP_SECRET errada', async () => {
  const r = await run(`
    require('./server/cloudbackup').restoreIfNeeded(require('path').join(process.env.DATA_DIR, 'nexus.db')).then(() => process.exit(0), e => { console.log(e.message); process.exit(2); });
  `, { ...env, DATA_DIR: dirC, APP_SECRET: 'outra' });
  assert.equal(r.code, 2);
});
