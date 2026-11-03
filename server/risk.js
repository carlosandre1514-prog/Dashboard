// Antifraude: pontuação de risco por pedido. Score >= REVIEW_AT segura a entrega até aprovação manual.
'use strict';
const { db } = require('./db');

const REVIEW_AT = Number(process.env.RISK_REVIEW_AT || 60);
const ago = min => new Date(Date.now() - min * 60000).toISOString();

function assess({ playerId, ip, totalCents, gameId, externalId, channel }) {
  const flags = [];
  const add = (points, code, text) => flags.push({ points, code, text });

  if (totalCents >= 100000) add(40, 'high_value', 'Valor muito alto (≥ R$ 1.000)');
  else if (totalCents >= 30000) add(20, 'value', 'Valor alto (≥ R$ 300)');

  if (playerId) {
    const p = db.prepare('SELECT created_at, blocked FROM players WHERE id = ?').get(playerId);
    if (p?.blocked) add(100, 'blocked', 'Conta bloqueada');
    if (p && p.created_at > ago(15)) add(20, 'new_account', 'Conta criada há menos de 15 minutos');
    const lastHour = db.prepare('SELECT COUNT(*) n FROM orders WHERE player_id = ? AND created_at > ?').get(playerId, ago(60)).n;
    if (lastHour >= 3) add(25, 'velocity', `${lastHour} pedidos da mesma conta na última hora`);
    const failed = db.prepare(`SELECT COUNT(*) n FROM orders WHERE player_id = ? AND created_at > ? AND status IN ('canceled','expired')`).get(playerId, ago(1440)).n;
    if (failed >= 3) add(15, 'abandoned', `${failed} pedidos cancelados/expirados em 24h`);
    const refunds = db.prepare(`SELECT COUNT(*) n FROM orders WHERE player_id = ? AND status = 'refunded'`).get(playerId).n;
    if (refunds >= 1) add(30, 'refund_history', `Histórico de ${refunds} estorno(s)/contestação`);
  }
  if (externalId && gameId) {
    const owners = db.prepare('SELECT COUNT(DISTINCT player_id) n FROM player_links WHERE game_id = ? AND external_id = ? AND player_id != ?').get(gameId, externalId, playerId ?? -1).n;
    if (owners > 0 && channel === 'site') add(30, 'shared_id', 'ID de jogador vinculado a outra conta do site');
  }
  if (ip) {
    const accounts = db.prepare('SELECT COUNT(*) n FROM players WHERE signup_ip = ? AND created_at > ?').get(ip, ago(1440)).n;
    if (accounts >= 3) add(25, 'multi_account', `${accounts} contas criadas do mesmo IP em 24h`);
    const pend = db.prepare(`SELECT COUNT(*) n FROM orders WHERE ip = ? AND status = 'pending' AND created_at > ?`).get(ip, ago(60)).n;
    if (pend >= 4) add(20, 'ip_velocity', `${pend} pedidos pendentes do mesmo IP na última hora`);
  }
  const score = Math.min(100, flags.reduce((a, f) => a + f.points, 0));
  return { score, flags, review: score >= REVIEW_AT };
}

module.exports = { assess, REVIEW_AT };
