// Consultas agregadas para o painel.
'use strict';
const { db } = require('./db');

const TZ = Number(process.env.TZ_OFFSET_MIN ?? -180); // America/Sao_Paulo
const LOCAL = col => `datetime(${col}, '${TZ} minutes')`;
const DAY = col => `date(${LOCAL(col)})`;
const PAID = `status IN ('paid','delivered')`;

function toUtcStart(day) { // 'YYYY-MM-DD' local → ISO UTC
  return new Date(Date.parse(day + 'T00:00:00Z') - TZ * 60000).toISOString();
}
function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function todayLocal() {
  return new Date(Date.now() + TZ * 60000).toISOString().slice(0, 10);
}
function dayList(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function range(q) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : todayLocal();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(to, -29);
  const len = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));
  const gameId = q.game ? Number(q.game) : null;
  return { from, to, len, prevFrom, prevTo, gameId };
}

// filtro comum: período + jogo
function where(alias, from, to, gameId) {
  const p = alias ? alias + '.' : '';
  const sql = `${p}created_at >= ? AND ${p}created_at < ?` + (gameId ? ` AND ${p}game_id = ?` : '');
  const args = [toUtcStart(from), toUtcStart(addDays(to, 1))];
  if (gameId) args.push(gameId);
  return { sql, args };
}

function kpis(from, to, gameId) {
  const w = where('', from, to, gameId);
  const o = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN ${PAID} THEN total_cents END),0) revenue,
      COALESCE(SUM(CASE WHEN ${PAID} AND verification IN ('provider','manual','game_signed','webhook') AND review = 0 THEN total_cents END),0) verified_revenue,
      SUM(CASE WHEN review = 1 AND status IN ('pending','paid') THEN 1 ELSE 0 END) in_review,
      COUNT(*) orders,
      SUM(CASE WHEN ${PAID} THEN 1 ELSE 0 END) paid_orders,
      COALESCE(SUM(CASE WHEN ${PAID} THEN coins_total END),0) coins,
      COALESCE(SUM(CASE WHEN ${PAID} THEN items_total END),0) items,
      COUNT(DISTINCT CASE WHEN ${PAID} THEN COALESCE(player_id, external_player_id) END) buyers,
      COALESCE(SUM(CASE WHEN status='refunded' THEN total_cents END),0) refunds,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) to_deliver
    FROM orders WHERE ${w.sql}`).get(...w.args);
  const e = db.prepare(`SELECT
      SUM(type='page_view') views,
      COUNT(DISTINCT CASE WHEN type='page_view' THEN visitor_id END) visitors,
      SUM(type='download') downloads,
      SUM(type='install') installs,
      SUM(type='session_start') sessions,
      COUNT(DISTINCT CASE WHEN type='session_start' THEN player_id END) active_players
    FROM events WHERE ${w.sql}`).get(...w.args);
  const pw = gameId
    ? db.prepare(`SELECT COUNT(*) n FROM players WHERE created_at >= ? AND created_at < ? AND origin_game_id = ?`).get(...w.args)
    : db.prepare(`SELECT COUNT(*) n FROM players WHERE created_at >= ? AND created_at < ?`).get(w.args[0], w.args[1]);
  const nb = db.prepare(`SELECT COUNT(DISTINCT o.player_id) n FROM orders o JOIN players p ON p.id = o.player_id
    WHERE o.status IN ('paid','delivered') AND o.created_at >= ? AND o.created_at < ? AND p.created_at >= ?${gameId ? ' AND o.game_id = ?' : ''}`)
    .get(w.args[0], w.args[1], w.args[0], ...(gameId ? [gameId] : []));
  const r = { ...o, ...e, signups: pw.n, new_buyers: nb.n };
  for (const k in r) r[k] = Number(r[k] || 0);
  r.aov = r.paid_orders ? Math.round(r.revenue / r.paid_orders) : 0;
  r.arppu = r.buyers ? Math.round(r.revenue / r.buyers) : 0;
  r.conversion = r.visitors ? r.buyers / r.visitors : 0;
  return r;
}

function series(from, to, gameId) {
  const w = where('', from, to, gameId);
  const days = dayList(from, to);
  const base = () => Object.fromEntries(days.map(d => [d, 0]));
  const out = {
    revenue: base(), orders: base(), coins: base(), items: base(),
    views: base(), visitors: base(), downloads: base(), sessions: base(), active: base(), signups: base(),
    rev_site: base(), rev_game: base(),
  };
  for (const r of db.prepare(`SELECT ${DAY('created_at')} d,
      SUM(CASE WHEN ${PAID} THEN total_cents ELSE 0 END) rev,
      SUM(CASE WHEN ${PAID} AND channel='site' THEN total_cents ELSE 0 END) rs,
      SUM(CASE WHEN ${PAID} AND channel='in_game' THEN total_cents ELSE 0 END) rg,
      COUNT(*) n,
      SUM(CASE WHEN ${PAID} THEN coins_total ELSE 0 END) c,
      SUM(CASE WHEN ${PAID} THEN items_total ELSE 0 END) i
    FROM orders WHERE ${w.sql} GROUP BY d`).all(...w.args)) {
    if (!(r.d in out.revenue)) continue;
    out.revenue[r.d] = r.rev; out.orders[r.d] = r.n; out.coins[r.d] = r.c; out.items[r.d] = r.i;
    out.rev_site[r.d] = r.rs; out.rev_game[r.d] = r.rg;
  }
  for (const r of db.prepare(`SELECT ${DAY('created_at')} d,
      SUM(type='page_view') v, COUNT(DISTINCT CASE WHEN type='page_view' THEN visitor_id END) uv,
      SUM(type='download') dl, SUM(type='session_start') s,
      COUNT(DISTINCT CASE WHEN type='session_start' THEN player_id END) a
    FROM events WHERE ${w.sql} GROUP BY d`).all(...w.args)) {
    if (!(r.d in out.views)) continue;
    out.views[r.d] = r.v; out.visitors[r.d] = r.uv; out.downloads[r.d] = r.dl; out.sessions[r.d] = r.s; out.active[r.d] = r.a;
  }
  const pargs = gameId ? w.args : w.args.slice(0, 2);
  for (const r of db.prepare(`SELECT ${DAY('created_at')} d, COUNT(*) n FROM players
      WHERE created_at >= ? AND created_at < ? ${gameId ? 'AND origin_game_id = ?' : ''} GROUP BY d`).all(...pargs)) {
    if (r.d in out.signups) out.signups[r.d] = r.n;
  }
  const res = { days };
  for (const k in out) res[k] = days.map(d => Number(out[k][d]));
  return res;
}

function breakdowns(from, to, gameId) {
  const w = where('o', from, to, gameId);
  const paid = `o.status IN ('paid','delivered')`;
  const q = (sql, ...a) => db.prepare(sql).all(...w.args, ...a);
  return {
    byGame: q(`SELECT g.id, g.name, g.accent, SUM(o.total_cents) revenue, COUNT(*) orders, SUM(o.coins_total) coins
      FROM orders o JOIN games g ON g.id=o.game_id WHERE ${w.sql} AND ${paid} GROUP BY g.id ORDER BY revenue DESC`),
    byProduct: q(`SELECT i.sku, i.name, i.type, g.name game, SUM(i.qty) qty, SUM(i.qty*i.unit_cents) revenue, SUM(i.qty*i.coins) coins
      FROM order_items i JOIN orders o ON o.id=i.order_id JOIN games g ON g.id=o.game_id
      WHERE ${w.sql} AND ${paid} GROUP BY o.game_id, i.sku ORDER BY revenue DESC LIMIT 12`),
    byType: q(`SELECT i.type key, SUM(i.qty*i.unit_cents) revenue, SUM(i.qty) qty
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${w.sql} AND ${paid} GROUP BY i.type ORDER BY revenue DESC`),
    byPlatform: q(`SELECT o.platform key, SUM(o.total_cents) revenue, COUNT(*) orders
      FROM orders o WHERE ${w.sql} AND ${paid} GROUP BY o.platform ORDER BY revenue DESC`),
    byPayment: q(`SELECT o.payment_method key, SUM(o.total_cents) revenue, COUNT(*) orders
      FROM orders o WHERE ${w.sql} AND ${paid} GROUP BY o.payment_method ORDER BY revenue DESC`),
    byChannel: q(`SELECT o.channel key, SUM(o.total_cents) revenue, COUNT(*) orders
      FROM orders o WHERE ${w.sql} AND ${paid} GROUP BY o.channel ORDER BY revenue DESC`),
    byStatus: q(`SELECT o.status key, COUNT(*) orders, SUM(o.total_cents) revenue
      FROM orders o WHERE ${w.sql} GROUP BY o.status`),
    heatmap: q(`SELECT CAST(strftime('%w', ${LOCAL('o.created_at')}) AS INTEGER) dow,
        CAST(strftime('%H', ${LOCAL('o.created_at')}) AS INTEGER) hour, COUNT(*) orders, SUM(o.total_cents) revenue
      FROM orders o WHERE ${w.sql} AND ${paid} GROUP BY dow, hour`),
    topBuyers: q(`SELECT p.id, p.username, p.email, COUNT(*) orders, SUM(o.total_cents) spent, SUM(o.coins_total) coins, MAX(o.created_at) last
      FROM orders o JOIN players p ON p.id = o.player_id WHERE ${w.sql} AND ${paid} GROUP BY p.id ORDER BY spent DESC LIMIT 10`),
    byVerification: q(`SELECT o.verification key, COUNT(*) orders, SUM(o.total_cents) revenue FROM orders o WHERE ${w.sql} AND ${paid} GROUP BY o.verification ORDER BY revenue DESC`),
    countries: (() => {
      const we = where('', from, to, gameId);
      return db.prepare(`SELECT country key, COUNT(DISTINCT visitor_id) visitors FROM events
        WHERE ${we.sql} AND type='page_view' GROUP BY country ORDER BY visitors DESC LIMIT 8`).all(...we.args);
    })(),
    eventsByGame: (() => {
      const we = where('e', from, to, gameId);
      return db.prepare(`SELECT g.id, g.name, SUM(e.type='download') downloads, SUM(e.type='session_start') sessions,
          COUNT(DISTINCT CASE WHEN e.type='session_start' THEN e.player_id END) players
        FROM events e JOIN games g ON g.id=e.game_id WHERE ${we.sql} GROUP BY g.id ORDER BY sessions DESC`).all(...we.args);
    })(),
  };
}

function overview(q) {
  const r = range(q);
  const cur = kpis(r.from, r.to, r.gameId);
  const prev = kpis(r.prevFrom, r.prevTo, r.gameId);
  return {
    range: r,
    kpis: cur, prev,
    series: series(r.from, r.to, r.gameId),
    breakdowns: breakdowns(r.from, r.to, r.gameId),
    totals: lifetime(r.gameId),
  };
}

function lifetime(gameId) {
  const g = gameId ? 'WHERE game_id = ?' : '';
  const a = gameId ? [gameId] : [];
  const o = db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${PAID} THEN total_cents END),0) revenue,
    COALESCE(SUM(CASE WHEN ${PAID} THEN coins_total END),0) coins, COUNT(*) orders FROM orders ${g}`).get(...a);
  const e = db.prepare(`SELECT SUM(type='download') downloads, COUNT(DISTINCT CASE WHEN type='session_start' THEN player_id END) players,
    COUNT(DISTINCT CASE WHEN type='page_view' THEN visitor_id END) visitors FROM events ${g}`).get(...a);
  const p = gameId ? db.prepare('SELECT COUNT(*) n FROM players WHERE origin_game_id = ?').get(gameId)
    : db.prepare('SELECT COUNT(*) n FROM players').get();
  const r = { ...o, ...e, accounts: p.n };
  for (const k in r) r[k] = Number(r[k] || 0);
  return r;
}

module.exports = { overview, range, todayLocal, addDays };
