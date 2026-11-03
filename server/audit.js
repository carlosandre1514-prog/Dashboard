// Auditoria encadeada por hash (tamper-evident) e histórico de cada pedido.
'use strict';
const { db } = require('./db');
const { sha256 } = require('./security');

let listeners = [];
const onAudit = fn => listeners.push(fn);

function rowHash(r) {
  return sha256([r.prev_hash, r.at, r.actor_type, r.actor_id ?? '', r.action, r.target ?? '', r.ip ?? '', r.severity, r.details ?? ''].join('|'));
}

function audit(actorType, actorId, action, { target = null, ip = null, ua = null, severity = 'info', details = null } = {}) {
  const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.hash || 'GENESIS';
  const r = {
    at: new Date().toISOString(), actor_type: actorType, actor_id: actorId == null ? null : String(actorId), action,
    target: target == null ? null : String(target), ip, user_agent: ua ? String(ua).slice(0, 200) : null, severity,
    details: details ? JSON.stringify(details) : null, prev_hash: prev,
  };
  r.hash = rowHash(r);
  db.prepare(`INSERT INTO audit_log(at, actor_type, actor_id, action, target, ip, user_agent, severity, details, prev_hash, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(r.at, r.actor_type, r.actor_id, r.action, r.target, r.ip, r.user_agent, r.severity, r.details, r.prev_hash, r.hash);
  for (const fn of listeners) { try { fn(r); } catch { } }
}

// confere a cadeia inteira; retorna o primeiro registro adulterado, se houver
function verifyChain() {
  let prev = 'GENESIS', n = 0;
  for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
    n++;
    if (r.prev_hash !== prev || rowHash(r) !== r.hash) return { ok: false, records: n, broken_at: r.id };
    prev = r.hash;
  }
  return { ok: true, records: n };
}

function orderEvent(orderId, kind, message, actor = 'system', data = null) {
  db.prepare('INSERT INTO order_events(order_id, kind, message, actor, data) VALUES (?,?,?,?,?)')
    .run(orderId, kind, message, actor, data ? JSON.stringify(data) : null);
}

module.exports = { audit, verifyChain, orderEvent, onAudit };
