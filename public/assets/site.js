// NEXUS — site público: catálogo, mercado, página do jogo, carrinho, checkout Pix e conta (login via Firebase).
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const int = v => Number(v || 0).toLocaleString('pt-BR');
const TYPE = { currency: 'Moedas', skin: 'Skins', item: 'Itens', pass: 'Passes', bundle: 'Pacotes' };
const TYPE_IC = { currency: 'coin', skin: 'skin', item: 'item', pass: 'pass', bundle: 'bundle' };
const PLAT = { pc: ['monitor', 'PC'], android: ['phone', 'Android'], ios: ['phone', 'iOS'], web: ['globe', 'Navegador'], console: ['gamepad', 'Console'] };
const STATUS = { pending: 'Aguardando pagamento', paid: 'Pago · será entregue no jogo', delivered: 'Entregue', refunded: 'Estornado', canceled: 'Cancelado', expired: 'Expirado' };

async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'nexus', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Erro ' + r.status); e.status = r.status; throw e; }
  return d;
}
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind;
  t.innerHTML = icon(kind === 'err' ? 'alert' : 'check', 16);
  const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3400);
}
const visitor = (() => { try { let v = localStorage.getItem('nx_v'); if (!v) { v = 'v' + crypto.getRandomValues(new Uint32Array(2)).join(''); localStorage.setItem('nx_v', v); } return v; } catch { return 'anon'; } })();
const track = (type, game) => fetch('/api/public/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nexus' }, body: JSON.stringify({ type, game, visitor, path: location.pathname }), keepalive: true }).catch(() => { });
let pollTimer = null;
function closeLayer() { $('#layer').replaceChildren(); clearInterval(pollTimer); }
function overlay(html, drawer = false) {
  clearInterval(pollTimer);
  $('#layer').innerHTML = `<div class="overlay ${drawer ? 'drawer-ov' : ''}">${html}</div>`;
  const ov = $('#layer .overlay');
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeLayer(); });
  $$('[data-x]', ov).forEach(b => b.onclick = closeLayer);
  return ov;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayer(); });

const S = { me: null, isAdmin: false, links: [], orders: [], info: { store_name: 'NEXUS' }, market: null, cart: {} };

// ============================================================ dados
async function loadMe() {
  const r = await api('GET', '/api/auth/me');
  S.me = r.player; S.isAdmin = r.is_admin || r.admin_eligible;
  if (S.me) { try { const m = await api('GET', '/api/public/me'); S.links = m.links || []; S.orders = m.orders || []; } catch { } }
}
async function loadMarket() { if (!S.market) S.market = await api('GET', '/api/public/market'); return S.market; }
const gameById = id => S.market?.games.find(g => g.id === id);
const productById = id => S.market?.products.find(p => p.id === id);

// carrinho: um por jogo (cada jogo gera seu próprio pedido e entrega)
function loadCart() { try { S.cart = JSON.parse(localStorage.getItem('nx_cart2')) || {}; } catch { S.cart = {}; } }
function saveCart() { try { localStorage.setItem('nx_cart2', JSON.stringify(S.cart)); } catch { } updateCartN(); }
const cartCount = () => Object.values(S.cart).flat().reduce((a, i) => a + i.qty, 0);
function updateCartN() { const n = $('#cartN'); if (n) { n.textContent = cartCount(); n.classList.toggle('hidden', !cartCount()); } }
function pruneCart() {
  if (!S.market) return;
  for (const slug of Object.keys(S.cart)) {
    S.cart[slug] = S.cart[slug].filter(i => productById(i.id));
    if (!S.cart[slug].length) delete S.cart[slug];
  }
  saveCart();
}
function addToCart(id) {
  const p = productById(id); if (!p) return;
  const g = gameById(p.game_id);
  const list = (S.cart[g.slug] ||= []);
  const it = list.find(i => i.id === id);
  if (p.stock != null && (it?.qty || 0) + 1 > p.stock) return toast('Estoque insuficiente', 'err');
  if ((it?.qty || 0) >= 20) return toast('Máximo de 20 unidades por item', 'err');
  it ? it.qty++ : list.push({ id, qty: 1 });
  saveCart(); toast(`${p.name} adicionado ao carrinho`);
}

// ============================================================ layout
function header() {
  const page = document.body.dataset.page;
  const name = S.me ? (S.me.display_name || S.me.username) : '';
  $('#nav').innerHTML = `<div class="wrap">
    <a class="brand" href="/"><img src="/assets/logo.svg" width="26" height="26" alt="">${esc((S.info.store_name || 'NEXUS').toUpperCase())}</a>
    <nav class="nav-links">
      <a href="/#jogos" class="${page === 'home' || page === 'game' ? 'on' : ''}">Jogos</a>
      <a href="/mercado" class="${page === 'market' ? 'on' : ''}">Mercado</a>
      ${S.isAdmin ? `<a href="/admin" class="nav-admin">${icon('command', 14)}Painel</a>` : ''}
    </nav>
    <div class="nav-r">
      <button class="btn ghost" id="cartBtn" aria-label="Carrinho">${icon('cart', 17)}<span class="cart-t">Carrinho</span><span class="cart-n hidden" id="cartN">0</span></button>
      ${S.me ? `<a class="btn" href="/conta" title="${esc(S.me.email || '')}">${icon('user', 15)}<span class="me-n">${esc(name)}</span></a>` : `<a class="btn primary" href="/conta">${icon('user', 15)}Entrar</a>`}
    </div></div>`;
  $('#foot').innerHTML = `<div class="wrap"><span>© ${new Date().getFullYear()} ${esc(S.info.store_name || 'NEXUS')} · Todos os direitos reservados</span>
    <span class="label">${icon('shield', 13)} Pagamento verificado · Entrega automática no jogo</span></div>`;
  $('#cartBtn').onclick = openCart;
  updateCartN();
}
const platIcons = ps => ps.map(p => PLAT[p] ? `<span title="${PLAT[p][1]}">${icon(PLAT[p][0], 15)}</span>` : '').join('');

// cartão de produto (usado na página do jogo e no mercado)
function productCard(p, { showGame = false, best = false } = {}) {
  const g = gameById(p.game_id) || {};
  const off = p.compare_cents && p.compare_cents > p.price_cents ? Math.round((1 - p.price_cents / p.compare_cents) * 100) : 0;
  const out = p.stock != null && p.stock <= 0;
  return `<article class="prod ${p.featured ? 'feat' : ''}" style="--ga:${esc(g.accent || '#3987e5')}">
    <div class="art ${p.type}">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : `<span class="glyph">${icon(TYPE_IC[p.type], 30)}</span>`}
      ${p.featured ? '<span class="tag accent ribbon">Destaque</span>' : best ? '<span class="tag accent ribbon">Melhor valor</span>' : ''}${off ? `<span class="tag off-tag off">−${off}%</span>` : ''}</div>
    <div class="pb">
      ${showGame ? `<a class="pgame" href="/jogo/${esc(g.slug)}"><i style="background:${esc(g.accent)}"></i>${esc(g.name)}</a>` : ''}
      <h4>${esc(p.name)}</h4>
      <span class="coins">${p.coins ? int(p.coins) + ' ' + esc(g.currency_name || '').toLowerCase() : TYPE[p.type]}${p.coins && p.price_cents ? ` · ${(p.coins / (p.price_cents / 100)).toFixed(0)}/R$` : ''}${p.stock != null && p.stock > 0 && p.stock <= 20 ? ` · restam ${p.stock}` : ''}</span>
      <div class="price"><b>${money(p.price_cents)}</b>${off ? `<s>${money(p.compare_cents)}</s>` : ''}</div>
      <button class="btn ${p.featured ? 'primary' : ''}" data-add="${p.id}" ${out ? 'disabled' : ''}>${out ? 'Esgotado' : icon('plus', 15) + 'Adicionar'}</button>
    </div></article>`;
}
function bindAdd(root) { $$('[data-add]', root).forEach(b => b.onclick = () => addToCart(Number(b.dataset.add))); }
// pacote de moedas com mais moedas por real em cada jogo
function bestValueIds(products) {
  const best = {};
  for (const p of products) if (p.type === 'currency' && p.coins) {
    const v = p.coins / p.price_cents;
    if (!best[p.game_id] || v > best[p.game_id].v) best[p.game_id] = { v, id: p.id };
  }
  return new Set(Object.values(best).map(b => b.id));
}

// ============================================================ HOME
async function home() {
  const [games] = await Promise.all([api('GET', '/api/public/games'), loadMarket()]);
  pruneCart();
  const feat = games[0];
  document.title = `${S.info.store_name || 'NEXUS'} · Jogos`;
  const hot = [...S.market.products].sort((a, b) => b.sold_30d - a.sold_30d).slice(0, 4);
  $('#main').innerHTML = `
    ${feat ? `<section class="hero">
      <div class="hero-cover">${coverSVG(feat, { w: 1600, h: 700, title: false })}</div>
      <div class="wrap">
        <div class="meta"><span class="tag accent">Destaque</span><span class="tag">${esc(feat.genre)}</span><span class="tag">v${esc(feat.version)}</span></div>
        <h1>${esc(feat.name)}</h1>
        <p class="lead">${esc(feat.tagline || feat.description)}</p>
        <div class="cta"><a class="btn primary lg" href="/jogo/${esc(feat.slug)}">${icon('download', 17)}Baixar grátis</a><a class="btn lg" href="/mercado?jogo=${esc(feat.slug)}">${icon('coin', 17)}Comprar ${esc(feat.currency_name)}</a></div>
        <div class="hero-stats">
          <div><span class="label">Jogos</span><b>${games.length}</b></div>
          <div><span class="label">Downloads</span><b>${int(games.reduce((a, g) => a + (g.downloads || 0), 0))}</b></div>
          <div><span class="label">Plataformas</span><b class="plat-ic">${platIcons([...new Set(games.flatMap(g => g.platforms))])}</b></div>
        </div>
      </div></section>` : ''}
    <section class="section" id="jogos"><div class="wrap">
      <div class="section-h"><div><span class="label">Catálogo</span><h2>Nossos jogos</h2><p>Baixe, jogue e turbine sua conta com itens oficiais.</p></div></div>
      ${games.length ? `<div class="game-grid">${games.map(g => `
        <a class="gcard" href="/jogo/${esc(g.slug)}">
          <div class="cv">${coverSVG(g)}<div class="tags">${g.status === 'beta' ? '<span class="tag accent">Beta</span>' : ''}<span class="tag">${esc(g.genre)}</span></div></div>
          <div class="bd"><h3>${esc(g.name)}</h3><p>${esc(g.tagline)}</p>
            <div class="ft"><span class="plat-ic">${platIcons(g.platforms)}</span><span>${int(g.downloads)} downloads${g.min_price ? ' · itens a partir de ' + money(g.min_price) : ''}</span></div></div>
        </a>`).join('')}</div>` : '<div class="box" style="text-align:center;color:var(--muted)">Nenhum jogo publicado ainda.</div>'}
    </div></section>
    ${hot.length ? `<section class="section" style="border-top:1px solid var(--line)"><div class="wrap">
      <div class="section-h"><div><span class="label">Mercado</span><h2>Mais vendidos agora</h2><p>Moedas, skins e passes de todos os jogos em um só lugar.</p></div><a class="btn" href="/mercado">Ver o mercado ${icon('chevronRight', 15)}</a></div>
      <div class="products" id="hot">${hot.map(p => productCard(p, { showGame: true })).join('')}</div>
    </div></section>` : ''}
    <section class="section" id="como-funciona" style="border-top:1px solid var(--line)"><div class="wrap">
      <div class="section-h"><div><span class="label">Loja oficial</span><h2>Compre com segurança, receba no jogo</h2></div></div>
      <div class="features">
        <div class="feature"><div class="fi">${icon('user', 18)}</div><h3>1 · Crie sua conta</h3><p>Entre com Google ou e-mail. Uma conta para todos os jogos, com e-mail confirmado para sua segurança.</p></div>
        <div class="feature"><div class="fi">${icon('pix', 18)}</div><h3>2 · Pague com Pix</h3><p>Escolha os itens, informe seu ID de jogador e pague com QR Code. O pagamento é conferido direto no banco.</p></div>
        <div class="feature"><div class="fi">${icon('bolt', 18)}</div><h3>3 · Receba automaticamente</h3><p>Pagamento confirmado, os itens chegam na sua conta na próxima vez que você abrir o jogo.</p></div>
      </div>
    </div></section>`;
  const h = $('#hot'); if (h) bindAdd(h);
}

// ============================================================ MERCADO
async function market() {
  await loadMarket(); pruneCart();
  document.title = `Mercado · ${S.info.store_name || 'NEXUS'}`;
  track('page_view');
  const q = new URLSearchParams(location.search);
  const f = { jogo: q.get('jogo') || '', tipo: q.get('tipo') || '', q: q.get('q') || '', ordem: q.get('ordem') || 'destaque', promo: q.get('promo') === '1', max: q.get('max') || '' };
  const { games, products } = S.market;
  const best = bestValueIds(products);
  const maxPrice = Math.max(1, ...products.map(p => p.price_cents));
  $('#main').innerHTML = `
    <section class="mk-head"><div class="wrap">
      <div><span class="label">Mercado oficial</span><h1>Mercado</h1><p class="t2">Moedas, skins, itens e passes de todos os jogos. Pagamento via Pix verificado e entrega automática.</p></div>
      <div class="mk-games" id="mkGames">
        <button data-g="" class="mk-g ${!f.jogo ? 'on' : ''}"><span class="mk-g-ic">${icon('layers', 18)}</span><span><b>Todos os jogos</b><small>${products.length} itens</small></span></button>
        ${games.map(g => `<button data-g="${esc(g.slug)}" class="mk-g ${f.jogo === g.slug ? 'on' : ''}" style="--ga:${esc(g.accent)}"><span class="mk-g-ic">${coverSVG(g, { w: 80, h: 80, title: false })}</span><span><b>${esc(g.name)}</b><small>${products.filter(p => p.game_id === g.id).length} itens · ${esc(g.currency_name)}</small></span></button>`).join('')}
      </div>
    </div></section>
    <section class="section" style="padding-top:28px"><div class="wrap mk-layout">
      <aside class="mk-side" id="mkSide">
        <div class="mk-block"><span class="label">Categoria</span>
          <div class="mk-list">${[['', 'Tudo', 'layers'], ...Object.entries(TYPE).map(([k, v]) => [k, v, TYPE_IC[k]])].map(([k, v, ic]) =>
            `<button data-t="${k}" class="${f.tipo === k ? 'on' : ''}">${icon(ic, 15)}<span>${v}</span><em>${products.filter(p => (!k || p.type === k) && (!f.jogo || gameById(p.game_id).slug === f.jogo)).length}</em></button>`).join('')}</div></div>
        <div class="mk-block"><span class="label">Preço máximo</span>
          <input type="range" id="mkMax" min="0" max="${maxPrice}" step="100" value="${f.max || maxPrice}"><div class="mk-range"><span>R$ 0</span><b id="mkMaxV">${money(f.max || maxPrice)}</b></div></div>
        <div class="mk-block"><label class="switch"><input type="checkbox" id="mkPromo" ${f.promo ? 'checked' : ''}> Só promoções</label></div>
        <div class="mk-trust">${icon('shield', 18)}<div><b>Compra protegida</b><small>Pagamento conferido no banco antes da entrega. Pedidos suspeitos passam por análise.</small></div></div>
      </aside>
      <div class="mk-main">
        <div class="mk-bar">
          <div class="input-group" style="flex:1">${icon('search', 15)}<input class="input" id="mkQ" placeholder="Buscar item, skin, pacote…" value="${esc(f.q)}"></div>
          <select class="select" id="mkSort" style="width:auto">${[['destaque', 'Destaques'], ['vendidos', 'Mais vendidos'], ['menor', 'Menor preço'], ['maior', 'Maior preço'], ['valor', 'Mais moedas por R$']].map(([k, v]) => `<option value="${k}" ${f.ordem === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="mk-count" id="mkCount"></div>
        <div class="products" id="mkGrid"></div>
      </div>
    </div></section>`;
  const sync = () => {
    const p = new URLSearchParams();
    if (f.jogo) p.set('jogo', f.jogo); if (f.tipo) p.set('tipo', f.tipo); if (f.q) p.set('q', f.q);
    if (f.ordem !== 'destaque') p.set('ordem', f.ordem); if (f.promo) p.set('promo', '1'); if (f.max && Number(f.max) < maxPrice) p.set('max', f.max);
    history.replaceState(null, '', '/mercado' + (p.toString() ? '?' + p : ''));
  };
  const render = () => {
    const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let list = products.filter(p => {
      const g = gameById(p.game_id);
      return (!f.jogo || g.slug === f.jogo) && (!f.tipo || p.type === f.tipo) && (!f.promo || (p.compare_cents && p.compare_cents > p.price_cents))
        && (!f.max || p.price_cents <= Number(f.max)) && (!f.q || norm(p.name + ' ' + g.name + ' ' + (p.description || '')).includes(norm(f.q)));
    });
    const sorters = { destaque: (a, b) => b.featured - a.featured || b.sold_30d - a.sold_30d, vendidos: (a, b) => b.sold_30d - a.sold_30d, menor: (a, b) => a.price_cents - b.price_cents,
      maior: (a, b) => b.price_cents - a.price_cents, valor: (a, b) => (b.coins / b.price_cents || 0) - (a.coins / a.price_cents || 0) };
    list.sort(sorters[f.ordem] || sorters.destaque);
    $('#mkCount').innerHTML = `<b>${list.length}</b> ${list.length === 1 ? 'item' : 'itens'}${f.jogo ? ' em ' + esc(games.find(g => g.slug === f.jogo)?.name) : ''}`;
    $('#mkGrid').innerHTML = list.length ? list.map(p => productCard(p, { showGame: !f.jogo, best: best.has(p.id) })).join('')
      : `<div class="box mk-empty">${icon('search', 28)}<p>Nenhum item com esses filtros.</p><button class="btn" id="mkClear">Limpar filtros</button></div>`;
    bindAdd($('#mkGrid'));
    const c = $('#mkClear'); if (c) c.onclick = () => { Object.assign(f, { tipo: '', q: '', promo: false, max: '' }); market(); history.replaceState(null, '', '/mercado'); };
    sync();
  };
  $$('#mkGames [data-g]').forEach(b => b.onclick = () => { f.jogo = b.dataset.g; sync(); market(); });
  $$('#mkSide [data-t]').forEach(b => b.onclick = () => { f.tipo = b.dataset.t; $$('#mkSide [data-t]').forEach(x => x.classList.toggle('on', x === b)); render(); });
  $('#mkQ').oninput = e => { f.q = e.target.value; render(); };
  $('#mkSort').onchange = e => { f.ordem = e.target.value; render(); };
  $('#mkPromo').onchange = e => { f.promo = e.target.checked; render(); };
  $('#mkMax').oninput = e => { f.max = e.target.value; $('#mkMaxV').textContent = money(f.max); render(); };
  render();
}

// ============================================================ JOGO
// Link vindo de dentro do jogo: /jogo/<slug>?id=<id do jogador>&sku=<pacote>  → já abre o pagamento
const fromGame = (() => {
  const q = new URLSearchParams(location.search);
  const id = (q.get('id') || '').trim(), sku = (q.get('sku') || '').trim().toUpperCase();
  return { id: /^[\w.\-:@]{2,80}$/.test(id) ? id : '', sku: /^[A-Z0-9_]{1,48}$/.test(sku) ? sku : '' };
})();
const rememberId = (slug, id) => { try { if (id) sessionStorage.setItem('nx_pid_' + slug, id); } catch { } };
const rememberedId = slug => { try { return sessionStorage.getItem('nx_pid_' + slug) || ''; } catch { return ''; } };

async function gamePage() {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  rememberId(slug, fromGame.id);
  let d;
  try { [d] = await Promise.all([api('GET', '/api/public/games/' + encodeURIComponent(slug)), loadMarket()]); }
  catch { return notFound(); }
  pruneCart();
  const g = d.game;
  document.title = `${g.name} · ${S.info.store_name || 'NEXUS'}`;
  track('page_view', g.slug);
  const products = S.market.products.filter(p => p.game_id === g.id);
  const best = bestValueIds(products);
  const types = [...new Set(products.map(p => p.type))];
  $('#main').innerHTML = `
    <section class="hero">
      <div class="hero-cover">${coverSVG(g, { w: 1600, h: 700, title: false })}</div>
      <div class="wrap">
        <div class="meta">${g.status === 'beta' ? '<span class="tag accent">Beta aberto</span>' : '<span class="tag accent">Disponível</span>'}<span class="tag">${esc(g.genre)}</span><span class="tag">v${esc(g.version)}</span></div>
        <h1>${esc(g.name)}</h1>
        <p class="lead">${esc(g.tagline)}</p>
        <div class="cta">
          ${g.download_url ? `<a class="btn primary lg" id="dlBtn" href="${esc(g.download_url)}" target="_blank" rel="noopener noreferrer">${icon('download', 17)}Baixar ${esc(g.name)}</a>` : `<button class="btn lg" disabled>${icon('download', 17)}Download em breve</button>`}
          ${products.length ? `<a class="btn lg" href="#loja">${icon('coin', 17)}Loja de ${esc(g.currency_name)}</a>` : ''}
        </div>
        <div class="hero-stats">
          <div><span class="label">Downloads</span><b>${int(g.downloads)}</b></div>
          <div><span class="label">Versão</span><b class="mono" style="font-size:16px">${esc(g.version)}</b></div>
          <div><span class="label">Plataformas</span><b class="plat-ic">${platIcons(g.platforms)}</b></div>
        </div>
      </div>
    </section>
    <section class="section"><div class="wrap g-layout">
      <div><span class="label">Sobre o jogo</span><h2 style="font-size:24px;margin:10px 0 16px">${esc(g.name)}</h2><p class="g-about">${esc(g.description)}</p></div>
      <aside class="g-side">
        <div class="row"><span>Gênero</span><span>${esc(g.genre || '—')}</span></div>
        <div class="row"><span>Versão</span><span class="mono">${esc(g.version)}</span></div>
        <div class="row"><span>Plataformas</span><span>${g.platforms.map(p => PLAT[p]?.[1] || p).join(', ')}</span></div>
        <div class="row"><span>Moeda do jogo</span><span>${esc(g.currency_name)}</span></div>
        <div class="row"><span>Status</span><span class="status ${g.status}">${g.status === 'beta' ? 'Beta' : 'Publicado'}</span></div>
      </aside>
    </div></section>
    ${products.length ? `<section class="section" id="loja" style="border-top:1px solid var(--line)"><div class="wrap">
      <div class="section-h"><div><span class="label">Loja oficial</span><h2>${esc(g.currency_name)}, skins e itens</h2><p>Pague com Pix e receba direto na sua conta do jogo.</p></div>
        <div class="seg store-tabs" id="tabs"><button data-t="" class="on">Tudo</button>${types.map(t => `<button data-t="${t}">${TYPE[t]}</button>`).join('')}</div></div>
      <div class="products" id="products"></div>
    </div></section>` : ''}`;
  const dl = $('#dlBtn'); if (dl) dl.addEventListener('click', () => track('download', g.slug));
  let filter = '';
  const render = () => { const el = $('#products'); if (!el) return; el.innerHTML = products.filter(p => !filter || p.type === filter).map(p => productCard(p, { best: best.has(p.id) })).join(''); bindAdd(el); };
  $$('#tabs button').forEach(b => b.onclick = () => { filter = b.dataset.t; $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); render(); });
  render();
  if (fromGame.sku) {
    const p = products.find(x => x.sku === fromGame.sku);
    history.replaceState(null, '', location.pathname + '#loja');
    if (p) {
      S.cart[g.slug] = [{ id: p.id, qty: 1 }]; saveCart();
      $('#loja')?.scrollIntoView();
      if (fromGame.id) toast('Compra para o jogador ' + fromGame.id);
      startCheckout(g.slug);
    } else toast('Esse pacote não está mais à venda', 'err');
  }
}

// ============================================================ carrinho e checkout
async function openCart() {
  await loadMarket(); pruneCart();
  const groups = Object.entries(S.cart).filter(([, l]) => l.length);
  const ov = overlay(`<aside class="drawer">
    <div class="dialog-h"><h3>Carrinho</h3><span class="label">${cartCount()} ${cartCount() === 1 ? 'item' : 'itens'}</span><button class="btn ghost icon sm x" data-x aria-label="Fechar">${icon('close', 16)}</button></div>
    <div class="cart-items">${groups.length ? groups.map(([slug, list]) => {
      const g = S.market.games.find(x => x.slug === slug);
      const total = list.reduce((a, i) => a + productById(i.id).price_cents * i.qty, 0);
      return `<div class="cg"><div class="cg-h"><i style="background:${esc(g.accent)}"></i><b>${esc(g.name)}</b><span class="muted">${money(total)}</span></div>
        ${list.map(i => { const p = productById(i.id); return `
        <div class="ci"><span class="pi art ${p.type}">${icon(TYPE_IC[p.type], 18)}</span><div><b>${esc(p.name)}</b><small>${money(p.price_cents)}${p.coins ? ' · ' + int(p.coins * i.qty) + ' ' + esc(g.currency_name).toLowerCase() : ''}</small></div>
          <div class="qty"><button data-q="${p.id}" data-s="${esc(slug)}" data-d="-1" aria-label="Menos">−</button><span>${i.qty}</span><button data-q="${p.id}" data-s="${esc(slug)}" data-d="1" aria-label="Mais">+</button></div></div>`; }).join('')}
        <button class="btn primary cg-pay" data-pay="${esc(slug)}">${icon('pix', 16)}Pagar ${money(total)} com Pix</button></div>`;
    }).join('') : `<div class="empty" style="padding:60px 0;text-align:center;color:var(--muted)">${icon('cart', 32)}<p style="margin-top:10px">Seu carrinho está vazio.</p><a class="btn" style="margin-top:16px" href="/mercado">Ir ao mercado</a></div>`}</div>
    ${groups.length > 1 ? `<div class="dialog-f"><small class="muted">Cada jogo gera um pedido separado, entregue na conta daquele jogo.</small></div>` : ''}
  </aside>`, true);
  $$('[data-q]', ov).forEach(b => b.onclick = () => {
    const list = S.cart[b.dataset.s]; const it = list.find(i => i.id === Number(b.dataset.q)); const p = productById(it.id);
    it.qty += Number(b.dataset.d);
    if (p.stock != null && it.qty > p.stock) { it.qty = p.stock; toast('Estoque insuficiente', 'err'); }
    if (it.qty > 20) it.qty = 20;
    if (it.qty <= 0) S.cart[b.dataset.s] = list.filter(x => x !== it);
    if (!S.cart[b.dataset.s].length) delete S.cart[b.dataset.s];
    saveCart(); openCart();
  });
  $$('[data-pay]', ov).forEach(b => b.onclick = () => startCheckout(b.dataset.pay));
}
async function startCheckout(slug) {
  if (!S.me) return loginDialog(() => startCheckout(slug), 'Entre para finalizar a compra');
  if (!S.me.email_verified) return verifyDialog(() => startCheckout(slug));
  checkout(slug);
}
function loginDialog(after, title = 'Entrar') {
  const ov = overlay(`<div class="dialog" style="max-width:420px"><div class="dialog-h"><h3>${esc(title)}</h3><button class="btn ghost icon sm x" data-x aria-label="Fechar">${icon('close', 16)}</button></div><div class="dialog-b" id="loginBox"></div></div>`);
  NXLogin($('#loginBox', ov), { onDone: async r => { closeLayer(); await loadMe(); header(); toast('Bem-vindo!', 'ok'); if (r.mfa_required) return mfaDialog(r.mfa_token); if (r.is_admin) toast('Acesso de administrador liberado'); after && after(); } });
}
function verifyDialog(after) {
  overlay(`<div class="dialog" style="max-width:460px"><div class="dialog-h"><h3>Confirme seu e-mail</h3><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:14px">
      <p class="t2">Por segurança, compras só são liberadas para contas com e-mail confirmado. Enviamos um link para <b style="color:var(--text)">${esc(S.me.email || '')}</b>.</p>
      <div class="nxl-msg" id="vMsg"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="vDone">${icon('check', 15)}Já confirmei</button><button class="btn" id="vSend">Reenviar e-mail</button></div>
    </div></div>`);
  $('#vSend').onclick = async () => { try { await (await NXWhenAuth()).resendVerification(); $('#vMsg').className = 'nxl-msg ok'; $('#vMsg').textContent = 'E-mail reenviado. Confira também a caixa de spam.'; } catch (e) { $('#vMsg').className = 'nxl-msg err'; $('#vMsg').textContent = NXAuth.message(e); } };
  $('#vDone').onclick = async () => {
    try {
      const r = await (await NXWhenAuth()).refreshVerification();
      if (!r) { closeLayer(); return loginDialog(after, 'Entre novamente'); }
      await loadMe(); header();
      if (S.me?.email_verified) { closeLayer(); toast('E-mail confirmado!', 'ok'); after && after(); }
      else { $('#vMsg').className = 'nxl-msg err'; $('#vMsg').textContent = 'Ainda não confirmado. Clique no link do e-mail e tente de novo.'; }
    } catch (e) { $('#vMsg').className = 'nxl-msg err'; $('#vMsg').textContent = NXAuth.message(e); }
  };
}
function checkout(slug) {
  const g = S.market.games.find(x => x.slug === slug);
  const list = S.cart[slug] || [];
  const total = list.reduce((a, i) => a + productById(i.id).price_cents * i.qty, 0);
  const linked = rememberedId(slug) ? { external_id: rememberedId(slug) } : S.links.find(l => l.slug === slug);
  const ov = overlay(`<form class="dialog" novalidate>
    <div class="dialog-h"><div><span class="label">${esc(g.name)}</span><h3 style="margin-top:4px">Finalizar compra</h3></div><button type="button" class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:16px">
      <label class="field"><span>Seu ID de jogador em ${esc(g.name)} *</span><input class="input mono" name="external_id" required maxlength="80" value="${esc(linked?.external_id || '')}" placeholder="Ex.: ${esc(g.slug.slice(0, 2).toUpperCase())}100245">
        <small>Fica no seu perfil dentro do jogo. Os itens serão enviados para essa conta — confira com atenção.</small></label>
      <div class="sumbox">${list.map(i => { const p = productById(i.id); return `<div><span class="t2">${i.qty}× ${esc(p.name)}</span><span class="num">${money(p.price_cents * i.qty)}</span></div>`; }).join('')}
        <div class="tot"><span>Total</span><span>${money(total)}</span></div></div>
      <p class="muted" style="font-size:12px;display:flex;gap:8px">${icon('shield', 15)}O valor final é calculado pelo servidor. O pagamento é conferido no banco antes de qualquer entrega.</p>
      <div class="nxl-msg err" id="coErr"></div>
    </div>
    <div class="dialog-f"><button type="button" class="btn" data-x>Voltar</button><button class="btn primary" type="submit">${icon('pix', 16)}Gerar Pix</button></div>
  </form>`);
  $('form', ov).onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.external_id.trim()) return $('#coErr').textContent = 'Informe seu ID de jogador.';
    const btn = $('[type=submit]', ov); btn.disabled = true;
    try {
      const r = await api('POST', '/api/public/checkout', { game: slug, external_id: fd.external_id.trim(), items: list.map(i => ({ product_id: i.id, qty: i.qty })) });
      delete S.cart[slug]; saveCart();
      payment(r);
    } catch (err) {
      btn.disabled = false;
      $('#coErr').textContent = err.message;
      if (err.status === 401) { await loadMe(); header(); loginDialog(() => checkout(slug)); }
    }
  };
}
function payment(r) {
  const o = r.order;
  overlay(`<div class="dialog" style="max-width:660px">
    <div class="dialog-h"><div><span class="label">Pedido</span><h3 class="mono" style="margin-top:4px">${esc(o.code)}</h3></div><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" id="payBody">
      ${r.pix ? `<div class="pix"><div class="qr" id="qr"></div>
        <div style="display:flex;flex-direction:column;gap:12px;min-width:0;width:100%">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px"><div><span class="label">Total</span><div style="font-size:28px;font-weight:700;margin-top:4px">${money(o.total_cents)}</div></div>
            <div style="text-align:right"><span class="label">Expira em</span><div class="mono" style="font-size:18px;margin-top:6px" id="countdown">--:--</div></div></div>
          <p class="t2" style="font-size:13px">No app do seu banco escolha <b style="color:var(--text)">Pix → Ler QR Code</b>, ou copie o código:</p>
          <div class="pix-code" id="pixCode">${esc(r.pix)}</div>
          <button class="btn" id="copyPix">${icon('copy', 15)}Copiar código Pix</button>
        </div></div>
        <div class="wait" style="margin-top:20px"><span class="spin"></span><span id="waitText">${r.automatic ? 'Aguardando o banco confirmar o pagamento… esta tela atualiza sozinha.' : 'Após pagar, a loja confere o pagamento no extrato e libera seu pedido. Esta tela atualiza sozinha.'}</span></div>`
      : `<p class="t2">Pedido criado, mas a loja ainda não configurou o recebimento Pix. Fale com o suporte informando o código <b class="mono" style="color:var(--text)">${esc(o.code)}</b>.</p>`}
    </div></div>`);
  if (!r.pix) return;
  try { const q = qrcode(0, 'M'); q.addData(r.pix); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
  catch { $('#qr').innerHTML = '<span style="color:#333;font-size:12px;text-align:center">Use o código copia-e-cola</span>'; }
  $('#copyPix').onclick = async () => { try { await navigator.clipboard.writeText(r.pix); toast('Código Pix copiado'); } catch { toast('Copie o código manualmente', 'err'); } };
  const exp = Date.parse(r.expires_at || o.expires_at || 0);
  const tick = () => { const s = Math.max(0, Math.floor((exp - Date.now()) / 1000)); const el = $('#countdown'); if (el) el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  tick();
  let n = 0;
  pollTimer = setInterval(async () => {
    tick();
    if (++n % 4) return; // consulta o status a cada ~4 s
    try {
      const st = await api('GET', '/api/public/orders/' + encodeURIComponent(o.code));
      const body = $('#payBody'); if (!body) return clearInterval(pollTimer);
      if ((st.status === 'paid' || st.status === 'delivered') && !st.in_review) {
        clearInterval(pollTimer);
        body.innerHTML = `<div class="success"><div class="ok">${icon('check', 26)}</div><h3 style="font-size:20px">Pagamento confirmado</h3>
          <p class="t2" style="margin:8px auto 20px;max-width:400px">Seus itens serão creditados automaticamente na conta <b class="mono" style="color:var(--text)">${esc(st.external_player_id)}</b> na próxima vez que você abrir o jogo.</p>
          <a class="btn" href="/conta">Ver meus pedidos</a></div>`;
      } else if (st.in_review && st.status === 'paid') {
        clearInterval(pollTimer);
        body.innerHTML = `<div class="success"><div class="ok" style="background:rgba(250,178,25,.12);color:#f3cf7a;border-color:rgba(250,178,25,.4)">${icon('shield', 24)}</div><h3 style="font-size:20px">Pagamento recebido — em verificação</h3>
          <p class="t2" style="margin:8px auto 20px;max-width:420px">Seu pedido passou por uma checagem de segurança de rotina e será liberado pela equipe em breve. Você não precisa pagar de novo.</p><a class="btn" href="/conta">Acompanhar pedido</a></div>`;
      } else if (['expired', 'canceled'].includes(st.status)) {
        clearInterval(pollTimer);
        body.innerHTML = `<div class="success"><h3 style="font-size:20px">Pix ${st.status === 'expired' ? 'expirado' : 'cancelado'}</h3><p class="t2" style="margin:8px 0 20px">Nenhum valor foi cobrado. Monte o carrinho novamente para gerar um novo Pix.</p><a class="btn" href="/mercado">Voltar ao mercado</a></div>`;
      }
    } catch { }
  }, 1000);
}

// ============================================================ CONTA
async function account() {
  document.title = 'Minha conta · ' + (S.info.store_name || 'NEXUS');
  track('page_view');
  if (!S.me) {
    $('#main').innerHTML = `<section class="section"><div class="wrap acc-login"><div class="box" id="loginBox"></div>
      <div class="acc-side"><span class="label">Por que criar conta</span>
        <ul><li>${icon('coin', 16)}Compre moedas, skins e passes de todos os jogos</li><li>${icon('shield', 16)}Pagamento verificado e histórico de pedidos</li><li>${icon('bolt', 16)}Entrega automática na conta do jogo</li></ul></div></div></section>`;
    NXLogin($('#loginBox'), { title: 'Sua conta NEXUS', kicker: 'Conta', subtitle: 'Entre ou crie sua conta para comprar e acompanhar pedidos.', onDone: async r => {
      await loadMe(); header();
      if (r.mfa_required) return mfaDialog(r.mfa_token);
      if (r.is_admin) { toast('Acesso de administrador liberado', 'ok'); }
      account();
    } });
    return;
  }
  const name = S.me.display_name || S.me.username;
  $('#main').innerHTML = `<section class="section"><div class="wrap" style="max-width:1000px">
    <div class="section-h"><div><span class="label">Conta</span><h2>Olá, ${esc(name)}</h2><p>${esc(S.me.email || '')}</p></div>
      <div style="display:flex;gap:8px">${S.isAdmin ? `<a class="btn primary" href="/admin">${icon('command', 15)}Abrir painel</a>` : ''}<button class="btn" id="logout">${icon('logout', 15)}Sair</button></div></div>
    ${!S.me.email_verified ? `<div class="banner" style="margin-bottom:18px">${icon('alert', 18)}<span>Confirme seu e-mail para liberar compras.</span><button class="btn sm" id="verify">Confirmar agora</button></div>` : ''}
    ${S.links.length ? `<div class="box" style="margin-bottom:18px"><h3>Contas de jogo vinculadas</h3><p class="t2" style="font-size:13px;margin-bottom:12px">IDs de jogador usados nas suas compras.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${S.links.map(l => `<span class="tag">${esc(l.name)} · ${esc(l.external_id)}</span>`).join('')}</div></div>` : ''}
    <div class="box" style="padding:0"><div style="padding:20px 24px 8px"><h3>Meus pedidos</h3></div>
      ${S.orders.length ? `<div class="table-wrap"><table class="table"><thead><tr><th style="padding-left:24px">Pedido</th><th>Jogo</th><th>Data</th><th class="r">Total</th><th style="padding-right:24px">Status</th></tr></thead><tbody>
        ${S.orders.map(o => `<tr><td class="code" style="padding-left:24px">${esc(o.code)}</td><td>${esc(o.game)}</td><td class="t2 mono" style="font-size:12px">${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td class="r">${money(o.total_cents)}</td><td style="padding-right:24px"><span class="status ${o.status}">${o.in_review && o.status === 'paid' ? 'Pago · em verificação' : STATUS[o.status]}</span></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="t2" style="padding:8px 24px 24px">Você ainda não fez nenhum pedido. <a href="/mercado" style="color:var(--accent)">Ver o mercado</a></p>'}
    </div></div></section>`;
  $('#logout').onclick = async () => { await (await NXWhenAuth()).logout(); S.me = null; S.isAdmin = false; header(); account(); };
  const v = $('#verify'); if (v) v.onclick = () => verifyDialog(() => { account(); });
}
function mfaDialog(token) {
  const ov = overlay(`<form class="dialog" style="max-width:400px" novalidate><div class="dialog-h"><h3>Verificação em duas etapas</h3><button type="button" class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:14px"><p class="t2" style="font-size:13px">Sua conta de administrador está protegida. Digite o código de 6 dígitos do app autenticador (ou um código de recuperação).</p>
    <input class="input mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="14" style="font-size:20px;letter-spacing:.3em;text-align:center">
    <label class="switch"><input type="checkbox" name="remember" checked> Lembrar este aparelho por 30 dias</label><div class="nxl-msg err" id="mErr"></div>
    <button class="btn primary lg">Confirmar</button></div></form>`);
  $('form', ov).onsubmit = async e => {
    e.preventDefault();
    try { const fd = new FormData(e.target); await NXAuth.mfa(token, fd.get('code'), !!fd.get('remember')); closeLayer(); await loadMe(); header(); account(); toast('Acesso de administrador liberado', 'ok'); }
    catch (err) { $('#mErr').textContent = err.message; }
  };
  $('input', ov).focus();
}

function notFound() {
  document.title = 'Página não encontrada';
  $('#main').innerHTML = `<section class="section"><div class="wrap" style="text-align:center;padding:80px 0">
    <span class="label">Erro 404</span><h2 style="font-size:32px;margin:12px 0">Página não encontrada</h2><p class="t2">O endereço que você acessou não existe ou foi removido.</p>
    <a class="btn primary" style="margin-top:24px" href="/">Voltar ao início</a></div></section>`;
}

// ============================================================ boot
(async () => {
  loadCart();
  try { S.info = await api('GET', '/api/public/info'); } catch { }
  try { await loadMe(); } catch { }
  header();
  const page = document.body.dataset.page;
  if (page === 'home') { track('page_view'); await home(); }
  else if (page === 'game') await gamePage();
  else if (page === 'market') await market();
  else if (page === 'account') await account();
  else notFound();
  if (location.hash) { try { $(location.hash)?.scrollIntoView(); } catch { } }
})();
