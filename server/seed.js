// Gera dados de demonstração realistas (jogos, produtos, jogadores, telemetria e vendas).
// Uso: npm run seed   — APAGA jogos, jogadores, pedidos e eventos (mantém admin e configurações).
'use strict';
const { db, tx, newApiKey, orderCode, setSetting, getSetting } = require('./db');

function rng(seed) { // mulberry32 — reprodutível
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const GAMES = [
  { slug: 'iron-veil', name: 'Iron Veil', tagline: 'Shooter tático por esquadrões em arenas destrutíveis',
    genre: 'FPS tático', status: 'live', version: '2.4.1', platforms: 'pc,android', accent: '#3987e5', currency_name: 'Créditos',
    description: 'Partidas 5v5 com destruição de cenário, classes especializadas e temporadas ranqueadas. Monte seu arsenal, desbloqueie skins e suba no ranking.',
    weight: 1.0, products: [
      ['CR_500', '500 Créditos', 'currency', 990, null, 500], ['CR_1200', '1.200 Créditos', 'currency', 1990, null, 1200],
      ['CR_2600', '2.600 Créditos', 'currency', 3990, 4490, 2600], ['CR_6500', '6.500 Créditos', 'currency', 8990, 9990, 6500],
      ['SKIN_RIFLE_NEON', 'Skin · Rifle Neon Pulse', 'skin', 2490, null, 0], ['SKIN_OPS_GHOST', 'Operador · Ghost Protocol', 'skin', 3490, null, 0],
      ['PASS_S7', 'Passe de Temporada S7', 'pass', 2990, null, 0] ] },
  { slug: 'ember-realms', name: 'Ember Realms', tagline: 'RPG de ação em mundo aberto com dragões e guildas',
    genre: 'RPG de ação', status: 'live', version: '1.9.0', platforms: 'pc,android,ios', accent: '#d95926', currency_name: 'Gemas',
    description: 'Explore reinos em chamas, domestique dragões e forme guildas com amigos. Eventos semanais, raides e um sistema de forja profundo.',
    weight: 0.8, products: [
      ['GEM_300', '300 Gemas', 'currency', 790, null, 300], ['GEM_1000', '1.000 Gemas', 'currency', 2290, null, 1000],
      ['GEM_3500', '3.500 Gemas', 'currency', 6990, 7990, 3500], ['MOUNT_DRAKE', 'Montaria · Drake de Brasa', 'item', 4990, null, 0],
      ['SKIN_PALADIN', 'Visual · Paladino Solar', 'skin', 2990, null, 0], ['VIP_30', 'VIP 30 dias', 'pass', 1990, null, 0],
      ['BUNDLE_START', 'Pacote Iniciante', 'bundle', 1490, 2990, 500] ] },
  { slug: 'drift-protocol', name: 'Drift Protocol', tagline: 'Corridas arcade cyberpunk com tuning extremo',
    genre: 'Corrida', status: 'beta', version: '0.8.3', platforms: 'pc', accent: '#199e70', currency_name: 'Chips',
    description: 'Corridas noturnas em uma megacidade neon. Personalize cada peça do carro e dispute ligas online semanais.',
    weight: 0.45, products: [
      ['CHIP_800', '800 Chips', 'currency', 1290, null, 800], ['CHIP_2500', '2.500 Chips', 'currency', 3490, null, 2500],
      ['CAR_VANTA', 'Carro · Vanta GT-R', 'item', 3990, null, 0], ['WRAP_HOLO', 'Envelopamento Holográfico', 'skin', 1490, null, 0],
      ['PASS_BETA', 'Passe Fundador (Beta)', 'pass', 2490, null, 0] ] },
];

const NAMES = ['kaze', 'nyx', 'vortex', 'luna', 'raptor', 'pixel', 'ghost', 'blaze', 'orion', 'zero', 'myst', 'tank', 'shade', 'ion', 'drako',
  'nova', 'frost', 'hex', 'echo', 'rex', 'vex', 'juju', 'bruxo', 'lobo', 'falcao', 'tigrao', 'sombra', 'ruiva', 'gordo', 'magrelo'];
const COUNTRIES = [['BR', 78], ['PT', 7], ['AR', 4], ['US', 4], ['MX', 3], ['CL', 2], ['AO', 2]];
const HOURS = [2, 1, .6, .4, .3, .3, .5, .9, 1.3, 1.6, 1.9, 2.2, 2.6, 2.5, 2.4, 2.6, 3, 3.6, 4.3, 5, 5.4, 5.2, 4.2, 3];
const DOW = [1.25, .85, .85, .9, 1, 1.15, 1.35];

function seed({ days = 120 } = {}) {
  const r = rng(20261103);
  const pick = (arr, w) => { // escolha ponderada
    if (!w) return arr[Math.floor(r() * arr.length)];
    const t = w.reduce((a, b) => a + b, 0); let x = r() * t;
    for (let i = 0; i < arr.length; i++) { x -= w[i]; if (x <= 0) return arr[i]; } return arr[arr.length - 1];
  };
  const country = () => pick(COUNTRIES.map(c => c[0]), COUNTRIES.map(c => c[1]));
  const hourW = HOURS;
  const at = (dayStart) => { // horário realista em UTC (dayStart = meia-noite local em ms)
    const h = pick([...Array(24).keys()], hourW);
    return new Date(dayStart + (h * 3600 + Math.floor(r() * 3600)) * 1000).toISOString();
  };
  const poisson = (l) => { if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * (r() + r() + r() - 1.5) * 1.4));
    let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };

  tx(() => {
    db.exec(`DELETE FROM order_items; DELETE FROM orders; DELETE FROM events; DELETE FROM player_links; DELETE FROM sessions WHERE kind = 'player'; DELETE FROM players; DELETE FROM products; DELETE FROM games;`);
    if (!getSetting('store_name')) setSetting('store_name', 'NEXUS Games');
    if (!getSetting('pix_key')) { setSetting('pix_key', 'pagamentos@nexusgames.dev'); setSetting('pix_name', 'NEXUS GAMES'); setSetting('pix_city', 'SAO PAULO'); }

    const nowMs = Date.now();
    const todayLocal = new Date(nowMs - 180 * 60000).toISOString().slice(0, 10);
    const dayStartOf = (i) => Date.parse(todayLocal + 'T00:00:00Z') + 180 * 60000 - i * 86400000;

    const gameRows = GAMES.map((g, gi) => {
      const created = new Date(dayStartOf(days + 5 - gi * 10)).toISOString();
      const res = db.prepare(`INSERT INTO games(slug, name, tagline, description, genre, status, version, platforms, download_url, accent, currency_name, api_key, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(g.slug, g.name, g.tagline, g.description, g.genre, g.status, g.version, g.platforms,
        `https://example.com/downloads/${g.slug}-${g.version}.zip`, g.accent, g.currency_name, newApiKey(), created);
      const id = Number(res.lastInsertRowid);
      const products = g.products.map(([sku, name, type, price, compare, coins], i) => {
        const pr = db.prepare(`INSERT INTO products(game_id, sku, name, type, price_cents, compare_cents, coins, featured, stock, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, sku, name, type, price, compare, coins, (i === 2 || type === 'pass') ? 1 : 0, type === 'item' ? 400 : null, created);
        // popularidade: pacotes baratos vendem mais
        return { id: Number(pr.lastInsertRowid), sku, name, type, price, coins, w: type === 'currency' ? 5 / (1 + i * .55) : type === 'pass' ? 2.2 : 1.3 };
      });
      return { ...g, id, products, players: [] };
    });

    const insP = db.prepare('INSERT INTO players(username, email, origin, origin_game_id, country, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)');
    const insL = db.prepare('INSERT INTO player_links(player_id, game_id, external_id) VALUES (?,?,?)');
    const insE = db.prepare('INSERT INTO events(type, game_id, player_id, visitor_id, platform, country, created_at) VALUES (?,?,?,?,?,?,?)');
    const insO = db.prepare(`INSERT INTO orders(code, game_id, player_id, external_player_id, channel, platform, payment_method, status, total_cents, coins_total, items_total, customer_name, created_at, paid_at, delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insI = db.prepare('INSERT INTO order_items(order_id, product_id, sku, name, type, qty, unit_cents, coins) VALUES (?,?,?,?,?,?,?,?)');
    let pseq = 0, vseq = 0;
    const visitors = [];

    for (let i = days - 1; i >= 0; i--) {
      const ds = dayStartOf(i);
      const dow = new Date(ds + 3 * 3600000).getUTCDay();
      const growth = 0.45 + 0.55 * ((days - i) / days) ** 1.3;         // tendência de crescimento
      const promo = (i % 30 === 9 || i % 30 === 10) ? 1.8 : 1;           // evento/promo mensal
      const season = DOW[dow] * growth * promo * (0.9 + r() * 0.2);

      // acessos ao site
      const views = poisson(520 * season);
      for (let k = 0; k < views; k++) {
        const newV = r() < 0.38 || !visitors.length;
        const v = newV ? `v${++vseq}` : visitors[Math.floor(r() * visitors.length)];
        if (newV) visitors.push(v);
        const g = r() < 0.25 ? null : pick(gameRows, gameRows.map(x => x.weight));
        insE.run('page_view', g?.id ?? null, null, v, pick(['pc', 'android', 'ios'], [55, 35, 10]), country(), at(ds));
      }

      for (const g of gameRows) {
        if (g.status === 'beta' && i > 75) continue; // beta lançado há 75 dias
        const gs = season * g.weight;
        // downloads / instalações
        const dl = poisson(32 * gs);
        for (let k = 0; k < dl; k++) {
          const plat = pick(g.platforms.split(','));
          const t = at(ds);
          insE.run('download', g.id, null, `v${1 + Math.floor(r() * vseq)}`, plat, country(), t);
          if (r() < 0.78) insE.run('install', g.id, null, null, plat, country(), t);
        }
        // novos jogadores (cadastro via jogo ou site)
        const signups = poisson(24 * gs);
        for (let k = 0; k < signups; k++) {
          const t = at(ds), fromSite = r() < 0.3;
          const u = `${pick(NAMES)}${pick(['', '_', '.', ''])}${Math.floor(r() * 9999)}`;
          const res = insP.run(`${u}-${++pseq}`, fromSite ? `${u}${pseq}@mail.com` : null, fromSite ? 'site' : 'game', g.id, country(), t, t);
          const pid = Number(res.lastInsertRowid);
          const ext = `${g.slug.slice(0, 2).toUpperCase()}${100000 + pseq}`;
          insL.run(pid, g.id, ext);
          insE.run('signup', g.id, pid, null, pick(g.platforms.split(',')), country(), t);
          g.players.push({ id: pid, ext, whale: r() < 0.06, since: i });
        }
        // sessões de jogadores ativos (retenção decai com o tempo)
        const pool = g.players;
        const actives = Math.min(pool.length, Math.round(pool.length * (0.16 + r() * 0.04)));
        for (let k = 0; k < actives; k++) {
          const p = pool[pool.length - 1 - Math.floor(r() ** 1.7 * pool.length)];
          const n = 1 + poisson(0.7);
          for (let s = 0; s < n; s++) insE.run('session_start', g.id, p.id, null, pick(g.platforms.split(',')), 'BR', at(ds));
        }
        // compras
        if (!pool.length) continue;
        const nOrders = poisson(Math.min(pool.length * 0.045, 9999) * DOW[dow] * promo * (0.85 + r() * 0.3));
        for (let k = 0; k < nOrders; k++) {
          const p = r() < 0.3 ? (pool.filter(x => x.whale)[Math.floor(r() * 20)] || pick(pool)) : pick(pool);
          const prod = pick(g.products, g.products.map(x => x.w * (p.whale && x.price > 3000 ? 3 : 1)));
          const qty = prod.type === 'currency' && r() < 0.12 ? 2 : 1;
          const total = prod.price * qty;
          const inGame = r() < 0.62;
          const plat = inGame ? pick(g.platforms.split(',')) : 'web';
          const method = inGame ? (plat === 'android' ? 'google_play' : plat === 'ios' ? 'app_store' : pick(['pix', 'card', 'steam'], [5, 3, 2])) : pick(['pix', 'card'], [7, 3]);
          const t = at(ds);
          const roll = r();
          const status = i < 1 && roll < 0.25 ? 'pending' : i < 2 && roll < 0.35 ? 'paid' : roll < 0.035 ? 'refunded' : roll < 0.075 ? 'canceled' : roll < 0.11 && i < 6 ? 'pending' : 'delivered';
          const paidAt = ['paid', 'delivered', 'refunded'].includes(status) ? new Date(Date.parse(t) + 60000 * (1 + r() * 20)).toISOString() : null;
          if (Date.parse(t) > nowMs) continue;
          const o = insO.run(orderCode(), g.id, p.id, p.ext, inGame ? 'in_game' : 'site', plat, method, status, total,
            prod.coins * qty, qty, null, t, paidAt, status === 'delivered' ? paidAt : null);
          insI.run(Number(o.lastInsertRowid), prod.id, prod.sku, prod.name, prod.type, qty, prod.price, prod.coins);
        }
      }
    }
    // remove eventos com horário no futuro (dia de hoje)
    db.prepare('DELETE FROM events WHERE created_at > ?').run(new Date(nowMs).toISOString());
    db.prepare('DELETE FROM players WHERE created_at > ?').run(new Date(nowMs).toISOString());
  });
}

module.exports = { seed };

if (require.main === module) {
  const t = Date.now();
  seed();
  const c = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  console.log(`Dados de demonstração gerados em ${((Date.now() - t) / 1000).toFixed(1)}s:`,
    { jogos: c('games'), produtos: c('products'), jogadores: c('players'), pedidos: c('orders'), eventos: c('events') });
}
