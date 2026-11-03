// Pagamentos: cobrança Pix, verificação no provedor, webhook assinado, conciliação, expiração e estorno.
// Regra de ouro: NUNCA confiar no corpo do webhook nem no navegador — o status é sempre consultado
// diretamente na API do provedor com o token secreto, e o valor/pedido conferidos antes de liberar.
'use strict';
const crypto = require('node:crypto');
const { db, tx, getSetting } = require('./db');
const { decrypt, hmac, safeEqual } = require('./security');
const { orderEvent, audit } = require('./audit');
const { brCode } = require('./pix');

const MP_API = process.env.MP_API_BASE || 'https://api.mercadopago.com';
const EXPIRE_MIN = Number(process.env.PIX_EXPIRE_MIN || 30);
const now = () => new Date().toISOString();

let emit = () => { };
const onChange = fn => { emit = fn; };

const provider = () => (getSetting('payment_provider') === 'mercadopago' && getSetting('mp_access_token')) ? 'mercadopago' : 'manual_pix';
const mpToken = () => decrypt(getSetting('mp_access_token') || '');

async function mp(method, path, body, idempotencyKey) {
  const r = await fetch(MP_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + mpToken(), 'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.message || `Mercado Pago HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
  return data;
}

// ============================================================ máquina de estados do pedido
const ALLOWED = {
  pending: ['paid', 'canceled', 'expired'],
  paid: ['delivered', 'refunded'],
  delivered: ['refunded'],
  canceled: [], expired: [], refunded: [],
};
function transition(orderId, status, { actor = 'system', message, fields = {}, force = false } = {}) {
  return tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new Error('Pedido não encontrado');
    if (o.status === status && !Object.keys(fields).length) return o;
    if (o.status !== status && !force && !ALLOWED[o.status].includes(status)) {
      const e = new Error(`Transição inválida: ${o.status} → ${status}`); e.status = 409; throw e;
    }
    if (['refunded', 'canceled', 'expired'].includes(status) && !['refunded', 'canceled', 'expired'].includes(o.status)) {
      for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(o.id))
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').run(it.qty, it.product_id);
    }
    const set = { status, ...fields };
    if (status === 'paid' && !o.paid_at) set.paid_at = now();
    if (status === 'delivered') { set.delivered_at = now(); if (!o.paid_at) set.paid_at = now(); }
    const keys = Object.keys(set);
    db.prepare(`UPDATE orders SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => set[k]), o.id);
    if (o.status !== status) orderEvent(o.id, 'status', message || `${o.status} → ${status}`, actor);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    emit(updated, o.status);
    return updated;
  });
}

// ============================================================ criação da cobrança
async function createCharge(order, { email, name } = {}) {
  const expires = new Date(Date.now() + EXPIRE_MIN * 60000);
  if (provider() === 'mercadopago') {
    const base = (getSetting('public_url') || '').replace(/\/$/, '');
    const pay = await mp('POST', '/v1/payments', {
      transaction_amount: order.total_cents / 100,
      description: `Pedido ${order.code}`,
      payment_method_id: 'pix',
      external_reference: order.code,
      date_of_expiration: expires.toISOString().replace('Z', '+00:00'),
      ...(base ? { notification_url: `${base}/api/webhooks/mercadopago` } : {}),
      payer: { email: email || 'comprador@example.com', first_name: name || undefined },
      metadata: { order_code: order.code },
    }, 'nx-' + order.code);
    const qr = pay.point_of_interaction?.transaction_data?.qr_code || null;
    db.prepare(`UPDATE orders SET provider = 'mercadopago', provider_payment_id = ?, provider_status = ?, pix_code = ?, expires_at = ? WHERE id = ?`)
      .run(String(pay.id), pay.status, qr, expires.toISOString(), order.id);
    orderEvent(order.id, 'charge', `Cobrança Pix criada no Mercado Pago (#${pay.id})`, 'system', { payment_id: pay.id, status: pay.status });
    return { provider: 'mercadopago', pix: qr, expires_at: expires.toISOString() };
  }
  const key = getSetting('pix_key');
  const code = key ? brCode({ key, name: getSetting('pix_name') || 'NEXUS', city: getSetting('pix_city') || 'SAO PAULO', amountCents: order.total_cents, txid: order.code }) : null;
  db.prepare(`UPDATE orders SET provider = 'manual_pix', pix_code = ?, expires_at = ? WHERE id = ?`).run(code, expires.toISOString(), order.id);
  orderEvent(order.id, 'charge', 'Pix estático gerado — exige conferência manual do extrato', 'system');
  return { provider: 'manual_pix', pix: code, expires_at: expires.toISOString() };
}

// ============================================================ aplicação do estado vindo do provedor
const maskDoc = n => { const d = String(n || '').replace(/\D/g, ''); if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`; if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/****-**`; return d ? '•••' + d.slice(-3) : null; };

function applyPayment(order, pay, source) {
  const checks = [];
  if (String(pay.external_reference || '') !== order.code) checks.push('Referência do pagamento não corresponde ao pedido');
  if (pay.currency_id && pay.currency_id !== 'BRL') checks.push(`Moeda inesperada: ${pay.currency_id}`);
  const paidCents = Math.round(Number(pay.transaction_amount || 0) * 100);
  if (paidCents !== order.total_cents) checks.push(`Valor divergente: pago ${(paidCents / 100).toFixed(2)} × esperado ${(order.total_cents / 100).toFixed(2)}`);
  if (order.provider_payment_id && String(pay.id) !== String(order.provider_payment_id)) checks.push('ID do pagamento diferente do registrado no pedido');

  const payer = pay.payer || {};
  const fields = {
    provider_status: pay.status, provider_payment_id: String(pay.id),
    paid_amount_cents: paidCents || null,
    net_amount_cents: pay.transaction_details?.net_received_amount != null ? Math.round(pay.transaction_details.net_received_amount * 100) : null,
    payer_email: payer.email || null,
    payer_name: [payer.first_name, payer.last_name].filter(Boolean).join(' ') || null,
    payer_doc: maskDoc(payer.identification?.number),
    e2e_id: pay.point_of_interaction?.transaction_data?.e2e_id || pay.transaction_details?.transaction_id || null,
  };
  orderEvent(order.id, 'provider', `Status consultado no Mercado Pago (${source}): ${pay.status}${pay.status_detail ? ' / ' + pay.status_detail : ''}`, 'system', { id: pay.id, status: pay.status, amount: pay.transaction_amount });

  if (pay.status === 'approved') {
    if (checks.length) {
      const flags = JSON.parse(order.risk_flags || '[]');
      flags.push({ points: 100, code: 'payment_mismatch', text: checks.join('; ') });
      db.prepare('UPDATE orders SET review = 1, risk_score = 100, risk_flags = ? WHERE id = ?').run(JSON.stringify(flags), order.id);
      orderEvent(order.id, 'alert', 'PAGAMENTO RETIDO: ' + checks.join('; '), 'system');
      audit('system', null, 'payment.mismatch', { target: order.code, severity: 'critical', details: { checks, payment_id: pay.id } });
      return transition(order.id, order.status === 'pending' ? 'paid' : order.status, { fields: { ...fields, verification: 'provider' }, message: 'Pagamento aprovado, porém com divergência — retido para análise' });
    }
    if (order.status === 'pending') {
      return transition(order.id, 'paid', { fields: { ...fields, verification: 'provider', verified_at: now() }, message: 'Pagamento confirmado e verificado no Mercado Pago' });
    }
    return transition(order.id, order.status, { fields });
  }
  if (['refunded', 'charged_back'].includes(pay.status) && ['paid', 'delivered'].includes(order.status)) {
    audit('system', null, pay.status === 'charged_back' ? 'payment.chargeback' : 'payment.refunded', { target: order.code, severity: 'warning' });
    return transition(order.id, 'refunded', { fields, message: pay.status === 'charged_back' ? 'Contestação (chargeback) aberta pelo pagador' : 'Pagamento estornado no Mercado Pago' });
  }
  if (['cancelled', 'rejected'].includes(pay.status) && order.status === 'pending') {
    return transition(order.id, 'canceled', { fields, message: `Pagamento ${pay.status === 'rejected' ? 'recusado' : 'cancelado'} no provedor` });
  }
  return transition(order.id, order.status, { fields });
}

async function verifyWithProvider(order, source = 'manual') {
  if (order.provider !== 'mercadopago') throw Object.assign(new Error('Este pedido não usa um provedor automático'), { status: 400 });
  let pay;
  if (order.provider_payment_id) pay = await mp('GET', `/v1/payments/${encodeURIComponent(order.provider_payment_id)}`);
  else {
    const r = await mp('GET', `/v1/payments/search?external_reference=${encodeURIComponent(order.code)}&sort=date_created&criteria=desc`);
    pay = r.results?.[0];
    if (!pay) return order;
  }
  return applyPayment(order, pay, source);
}

// ============================================================ webhook do Mercado Pago (assinatura x-signature)
function checkMpSignature(req, dataId) {
  const secret = decrypt(getSetting('mp_webhook_secret') || '');
  if (!secret) return 'Segredo do webhook não configurado';
  const sig = String(req.headers['x-signature'] || '');
  const reqId = String(req.headers['x-request-id'] || '');
  const parts = Object.fromEntries(sig.split(',').map(p => p.trim().split('=')).filter(p => p.length === 2));
  if (!parts.ts || !parts.v1) return 'Cabeçalho x-signature ausente';
  const ts = Number(parts.ts);
  const tsSec = ts > 1e12 ? ts / 1000 : ts;
  if (Math.abs(Date.now() / 1000 - tsSec) > 600) return 'Notificação antiga (fora da janela de 10 min)';
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${reqId};ts:${parts.ts};`;
  if (!safeEqual(hmac(secret, manifest), parts.v1)) return 'Assinatura inválida';
  return null;
}
async function handleMpWebhook(req, query, body, ip) {
  const dataId = String(query['data.id'] || body?.data?.id || '');
  const type = query.type || body?.type;
  if (!dataId) return { ignored: true };
  const err = checkMpSignature(req, dataId);
  if (err) {
    audit('system', null, 'webhook.rejected', { target: dataId, ip, severity: 'critical', details: { reason: err } });
    throw Object.assign(new Error(err), { status: 401 });
  }
  if (type && type !== 'payment') return { ignored: true };
  const pay = await mp('GET', `/v1/payments/${encodeURIComponent(dataId)}`);
  const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(pay.external_reference || ''));
  if (!order) { audit('system', null, 'webhook.unknown_order', { target: dataId, ip, severity: 'warning' }); return { ignored: true }; }
  applyPayment(order, pay, 'webhook');
  return { ok: true };
}

// ============================================================ estorno
async function refund(order, actor) {
  if (order.provider === 'mercadopago' && order.provider_payment_id) {
    await mp('POST', `/v1/payments/${encodeURIComponent(order.provider_payment_id)}/refunds`, {}, 'nx-refund-' + order.code);
    orderEvent(order.id, 'refund', 'Estorno solicitado ao Mercado Pago — dinheiro devolvido ao pagador', actor);
  } else {
    orderEvent(order.id, 'refund', 'Estorno registrado (devolva o valor manualmente ao pagador)', actor);
  }
  return transition(order.id, 'refunded', { actor, message: 'Pedido estornado' });
}

// ============================================================ conciliação e expiração (rodam em segundo plano)
async function reconcile() {
  if (provider() === 'mercadopago') {
    const pend = db.prepare(`SELECT * FROM orders WHERE provider = 'mercadopago' AND status IN ('pending','paid') AND created_at > ? ORDER BY created_at DESC LIMIT 50`)
      .all(new Date(Date.now() - 3 * 86400000).toISOString());
    for (const o of pend) {
      if (o.status === 'paid' && o.verification === 'provider' && !o.review) continue;
      try { await verifyWithProvider(o, 'conciliação'); } catch { /* tenta de novo no próximo ciclo */ }
    }
  }
  const expired = db.prepare(`SELECT * FROM orders WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`).all(now());
  for (const o of expired) {
    try {
      if (o.provider === 'mercadopago' && o.provider_payment_id) {
        // confirma uma última vez antes de expirar (pagamento pode ter chegado no último minuto)
        const after = await verifyWithProvider(o, 'expiração').catch(() => o);
        if (after.status !== 'pending') continue;
        mp('PUT', `/v1/payments/${encodeURIComponent(o.provider_payment_id)}`, { status: 'cancelled' }).catch(() => { });
      }
      transition(o.id, 'expired', { message: `Pix expirou sem pagamento (${EXPIRE_MIN} min)` });
    } catch { }
  }
}
function startJobs() {
  const t = setInterval(() => reconcile().catch(() => { }), 60000);
  t.unref();
  setTimeout(() => reconcile().catch(() => { }), 3000).unref();
}

const newWebhookSecret = () => crypto.randomBytes(32).toString('hex');
module.exports = { provider, createCharge, verifyWithProvider, handleMpWebhook, refund, transition, reconcile, startJobs, onChange, applyPayment, newWebhookSecret, EXPIRE_MIN };
