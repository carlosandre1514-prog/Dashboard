// NEXUS — site público: catálogo, página do jogo (download + loja), carrinho, checkout Pix e conta.
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const int = v => Number(v || 0).toLocaleString('pt-BR');
const TYPE = { currency: 'Moedas', skin: 'Skins', item: 'Itens', pass: 'Passes', bundle: 'Pacotes' };
const TYPE_IC = { currency: 'coin', skin: 'skin', item: 'item', pass: 'pass', bundle: 'bundle' };
const PLAT = { pc: ['monitor', 'PC'], android: ['phone', 'Android'], ios: ['phone', 'iOS'], web: ['globe', 'Navegador'], console: ['gamepad', 'Console'] };
const STATUS = { pending: 'Aguardando pagamento', paid: 'Pago · será entregue no jogo', delivered: 'Entregue', refunded: 'Estornado', canceled: 'Cancelado' };

async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Erro ' + r.status); e.status = r.status; throw e; }
  return d;
}
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind;
  t.innerHTML = icon(kind === 'err' ? 'alert' : 'check', 16);
  const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200);
}
const visitor = (() => { try { let v = localStorage.getItem('nx_v'); if (!v) { v = 'v' + crypto.getRandomValues(new Uint32Array(2)).join(''); localStorage.setItem('nx_v', v); } return v; } catch { return 'anon'; } })();
const track = (type, game) => fetch('/api/public/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, game, visitor, path: location.pathname }), keepalive: true }).catch(() => { });
function closeLayer() { $('#layer').replaceChildren(); }
function overlay(html, drawer = false) {
  $('#layer').innerHTML = `<div class="overlay ${drawer ? 'drawer-ov' : ''}">${html}</div>`;
  const ov = $('#layer .overlay');
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeLayer(); });
  $$('[data-x]', ov).forEach(b => b.onclick = closeLayer);
  return ov;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayer(); });

const S = { me: null, info: { store_name: 'NEXUS' }, game: null, products: [], cart: [], filter: '' };

// ============================================================ layout
function header() {
  const page = document.body.dataset.page;
  $('#nav').innerHTML = `<div class="wrap">
    <a class="brand" href="/"><img src="/assets/logo.svg" width="26" height="26" alt="">${esc((S.info.store_name || 'NEXUS').toUpperCase())}</a>
    <nav class="nav-links"><a href="/#jogos" class="${page === 'home' ? 'on' : ''}">Jogos</a><a href="/#como-funciona">Como funciona</a>${S.info.support_email ? `<a href="mailto:${esc(S.info.support_email)}">Suporte</a>` : ''}</nav>
    <div class="nav-r">
      ${page === 'game' ? `<button class="btn ghost" id="cartBtn">${icon('cart', 17)}<span>Carrinho</span><span class="cart-n" id="cartN">0</span></button>` : ''}
      ${S.me ? `<a class="btn" href="/conta">${icon('user', 15)}${esc(S.me.username)}</a>` : `<a class="btn" href="/conta">${icon('user', 15)}Entrar</a>`}
    </div></div>`;
  $('#foot').innerHTML = `<div class="wrap"><span>© ${new Date().getFullYear()} ${esc(S.info.store_name || 'NEXUS')} · Todos os direitos reservados</span>
    <span class="label">Pagamentos via Pix · Entrega automática no jogo</span></div>`;
  const cb = $('#cartBtn'); if (cb) cb.onclick = openCart;
}
const platIcons = ps => ps.map(p => PLAT[p] ? `<span title="${PLAT[p][1]}">${icon(PLAT[p][0], 15)}</span>` : '').join('');

// ============================================================ HOME
async function home() {
  const games = await api('GET', '/api/public/games');
  const feat = games[0];
  document.title = `${S.info.store_name || 'NEXUS'} · Jogos`;
  $('#main').innerHTML = `
    ${feat ? `<section class="hero">
      <div class="hero-cover">${coverSVG(feat, { w: 1600, h: 700, title: false })}</div>
      <div class="wrap">
        <div class="meta"><span class="tag accent">Destaque</span><span class="tag">${esc(feat.genre)}</span><span class="tag">v${esc(feat.version)}</span></div>
        <h1>${esc(feat.name)}</h1>
        <p class="lead">${esc(feat.tagline || feat.description)}</p>
        <div class="cta"><a class="btn primary lg" href="/jogo/${esc(feat.slug)}">${icon('download', 17)}Baixar grátis</a><a class="btn lg" href="/jogo/${esc(feat.slug)}#loja">${icon('coin', 17)}Comprar ${esc(feat.currency_name)}</a></div>
        <div class="hero-stats">
          <div><span class="label">Jogos</span><b>${games.length}</b></div>
          <div><span class="label">Downloads</span><b>${int(games.reduce((a, g) => a + (g.downloads || 0), 0))}</b></div>
          <div><span class="label">Plataformas</span><b class="plat-ic" style="margin-top:8px">${platIcons([...new Set(games.flatMap(g => g.platforms))])}</b></div>
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
    <section class="section" id="como-funciona" style="border-top:1px solid var(--line)"><div class="wrap">
      <div class="section-h"><div><span class="label">Loja oficial</span><h2>Compre com segurança, receba no jogo</h2></div></div>
      <div class="features">
        <div class="feature"><div class="fi">${icon('user', 18)}</div><h3>1 · Crie sua conta</h3><p>Uma conta única para todos os nossos jogos. Acompanhe seus pedidos em um só lugar.</p></div>
        <div class="feature"><div class="fi">${icon('pix', 18)}</div><h3>2 · Pague com Pix</h3><p>Escolha moedas, skins ou passes, informe seu ID de jogador e pague na hora com QR Code.</p></div>
        <div class="feature"><div class="fi">${icon('bolt', 18)}</div><h3>3 · Receba automaticamente</h3><p>Com o pagamento confirmado, os itens chegam na sua conta na próxima vez que você abrir o jogo.</p></div>
      </div>
    </div></section>`;
}

// ============================================================ JOGO
async function gamePage() {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  let d;
  try { d = await api('GET', '/api/public/games/' + encodeURIComponent(slug)); }
  catch { return notFound(); }
  S.game = d.game; S.products = d.products;
  try { S.cart = (JSON.parse(localStorage.getItem('nx_cart_' + S.game.slug)) || []).filter(i => S.products.some(p => p.id === i.id)); } catch { S.cart = []; }
  const g = S.game;
  document.title = `${g.name} · ${S.info.store_name || 'NEXUS'}`;
  track('page_view', g.slug);
  const types = [...new Set(S.products.map(p => p.type))];
  $('#main').innerHTML = `
    <section class="hero">
      <div class="hero-cover">${coverSVG(g, { w: 1600, h: 700, title: false })}</div>
      <div class="wrap">
        <div class="meta">${g.status === 'beta' ? '<span class="tag accent">Beta aberto</span>' : '<span class="tag accent">Disponível</span>'}<span class="tag">${esc(g.genre)}</span><span class="tag">v${esc(g.version)}</span></div>
        <h1>${esc(g.name)}</h1>
        <p class="lead">${esc(g.tagline)}</p>
        <div class="cta">
          ${g.download_url ? `<a class="btn primary lg" id="dlBtn" href="${esc(g.download_url)}" target="_blank" rel="noopener">${icon('download', 17)}Baixar ${esc(g.name)}</a>` : `<button class="btn lg" disabled>${icon('download', 17)}Download em breve</button>`}
          ${S.products.length ? `<a class="btn lg" href="#loja">${icon('coin', 17)}Loja de ${esc(g.currency_name)}</a>` : ''}
        </div>
        <div class="hero-stats">
          <div><span class="label">Downloads</span><b>${int(g.downloads)}</b></div>
          <div><span class="label">Versão</span><b class="mono" style="font-size:16px">${esc(g.version)}</b></div>
          <div><span class="label">Plataformas</span><b class="plat-ic" style="margin-top:8px">${platIcons(g.platforms)}</b></div>
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
    ${S.products.length ? `<section class="section" id="loja" style="border-top:1px solid var(--line)"><div class="wrap">
      <div class="section-h"><div><span class="label">Loja oficial</span><h2>${esc(g.currency_name)}, skins e itens</h2><p>Pague com Pix e receba direto na sua conta do jogo.</p></div>
        <div class="seg store-tabs" id="tabs"><button data-t="" class="on">Tudo</button>${types.map(t => `<button data-t="${t}">${TYPE[t]}</button>`).join('')}</div></div>
      <div class="products" id="products"></div>
    </div></section>` : ''}`;
  const dl = $('#dlBtn'); if (dl) dl.addEventListener('click', () => track('download', g.slug));
  $$('#tabs button').forEach(b => b.onclick = () => { S.filter = b.dataset.t; $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); renderProducts(); });
  renderProducts(); updateCartN();
}
function renderProducts() {
  const el = $('#products'); if (!el) return;
  const list = S.products.filter(p => !S.filter || p.type === S.filter);
  el.innerHTML = list.map(p => {
    const off = p.compare_cents && p.compare_cents > p.price_cents ? Math.round((1 - p.price_cents / p.compare_cents) * 100) : 0;
    const out = p.stock != null && p.stock <= 0;
    return `<article class="prod ${p.featured ? 'feat' : ''}">
      <div class="art ${p.type}">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : `<span class="glyph">${icon(TYPE_IC[p.type], 30)}</span>`}
        ${p.featured ? '<span class="tag accent ribbon">Destaque</span>' : ''}${off ? `<span class="tag off-tag off">−${off}%</span>` : ''}</div>
      <div class="pb"><h4>${esc(p.name)}</h4>
        <span class="coins">${p.coins ? int(p.coins) + ' ' + esc(S.game.currency_name).toLowerCase() : TYPE[p.type]}${p.stock != null && p.stock > 0 && p.stock <= 20 ? ` · restam ${p.stock}` : ''}</span>
        <div class="price"><b>${money(p.price_cents)}</b>${off ? `<s>${money(p.compare_cents)}</s>` : ''}</div>
        <button class="btn ${p.featured ? 'primary' : ''}" data-add="${p.id}" ${out ? 'disabled' : ''}>${out ? 'Esgotado' : icon('plus', 15) + 'Adicionar'}</button></div>
    </article>`;
  }).join('');
  $$('[data-add]', el).forEach(b => b.onclick = () => addToCart(Number(b.dataset.add)));
}

// ---------- carrinho ----------
function saveCart() { try { localStorage.setItem('nx_cart_' + S.game.slug, JSON.stringify(S.cart)); } catch { } updateCartN(); }
function updateCartN() { const n = $('#cartN'); if (n) n.textContent = S.cart.reduce((a, i) => a + i.qty, 0); }
const prodOf = id => S.products.find(p => p.id === id);
function addToCart(id) {
  const p = prodOf(id), it = S.cart.find(i => i.id === id);
  if (p.stock != null && (it?.qty || 0) + 1 > p.stock) return toast('Estoque insuficiente', 'err');
  it ? it.qty++ : S.cart.push({ id, qty: 1 });
  saveCart(); toast(`${p.name} adicionado`);
}
const cartTotal = () => S.cart.reduce((a, i) => a + prodOf(i.id).price_cents * i.qty, 0);
function openCart() {
  const ov = overlay(`<aside class="drawer">
    <div class="dialog-h"><h3>Carrinho</h3><span class="label">${esc(S.game.name)}</span><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="cart-items">${S.cart.length ? S.cart.map(i => { const p = prodOf(i.id); return `
      <div class="ci"><span class="pi art ${p.type}">${icon(TYPE_IC[p.type], 18)}</span><div><b>${esc(p.name)}</b><small>${money(p.price_cents)}${p.coins ? ' · ' + int(p.coins * i.qty) + ' ' + esc(S.game.currency_name).toLowerCase() : ''}</small></div>
        <div class="qty"><button data-q="${p.id}" data-d="-1" aria-label="Menos">${icon('close', 12)}</button><span>${i.qty}</span><button data-q="${p.id}" data-d="1" aria-label="Mais">${icon('plus', 12)}</button></div></div>`; }).join('')
      : `<div class="empty" style="padding:60px 0;text-align:center;color:var(--muted)">${icon('cart', 32)}<p style="margin-top:10px">Seu carrinho está vazio.</p></div>`}</div>
    <div class="dialog-f" style="flex-direction:column;align-items:stretch">
      <div class="cart-total"><span class="t2">Total</span><b>${money(cartTotal())}</b></div>
      <button class="btn primary lg" id="goCheckout" ${S.cart.length ? '' : 'disabled'}>${icon('pix', 17)}Pagar com Pix</button></div>
  </aside>`, true);
  $$('[data-q]', ov).forEach(b => b.onclick = () => {
    const it = S.cart.find(i => i.id === Number(b.dataset.q)); const p = prodOf(it.id);
    it.qty += Number(b.dataset.d);
    if (p.stock != null && it.qty > p.stock) { it.qty = p.stock; toast('Estoque insuficiente', 'err'); }
    if (it.qty <= 0) S.cart = S.cart.filter(x => x !== it);
    saveCart(); openCart();
  });
  $('#goCheckout').onclick = () => S.me ? checkout() : authDialog(checkout);
}
function checkout() {
  const g = S.game;
  const linked = (S.links || []).find(l => l.slug === g.slug);
  const ov = overlay(`<form class="dialog" novalidate>
    <div class="dialog-h"><h3>Finalizar compra</h3><button type="button" class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:16px">
      <label class="field"><span>Seu ID de jogador em ${esc(g.name)} *</span><input class="input mono" name="external_id" required value="${esc(linked?.external_id || '')}" placeholder="Ex.: ${esc(g.slug.slice(0, 2).toUpperCase())}100245">
        <small>Fica no perfil dentro do jogo. É para essa conta que os itens serão enviados.</small></label>
      <label class="field"><span>Observação (opcional)</span><input class="input" name="note"></label>
      <div style="border:1px solid var(--line);border-radius:var(--r);padding:4px 14px">${S.cart.map(i => { const p = prodOf(i.id); return `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line)"><span class="t2">${i.qty}× ${esc(p.name)}</span><span class="num">${money(p.price_cents * i.qty)}</span></div>`; }).join('')}
        <div style="display:flex;justify-content:space-between;padding:10px 0;font-weight:600"><span>Total</span><span>${money(cartTotal())}</span></div></div>
      <div class="err" id="coErr"></div>
    </div>
    <div class="dialog-f"><button type="button" class="btn" data-x>Voltar</button><button class="btn primary" type="submit">${icon('pix', 16)}Gerar Pix</button></div>
  </form>`);
  $('form', ov).onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.external_id.trim()) return $('#coErr').textContent = 'Informe seu ID de jogador.';
    try {
      const r = await api('POST', '/api/public/checkout', { game: g.slug, external_id: fd.external_id.trim(), note: fd.note, items: S.cart.map(i => ({ product_id: i.id, qty: i.qty })) });
      S.cart = []; saveCart();
      payment(r);
    } catch (err) { $('#coErr').textContent = err.message; if (err.status === 401) authDialog(checkout); }
  };
}
function payment(r) {
  const o = r.order;
  const ov = overlay(`<div class="dialog" style="max-width:640px">
    <div class="dialog-h"><div><span class="label">Pedido</span><h3 class="mono" style="margin-top:4px">${esc(o.code)}</h3></div><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" id="payBody">
      ${r.pix ? `<div class="pix"><div class="qr" id="qr"></div>
        <div style="display:flex;flex-direction:column;gap:12px;min-width:0;width:100%">
          <div><span class="label">Total</span><div style="font-size:28px;font-weight:700;margin-top:4px">${money(o.total_cents)}</div></div>
          <p class="t2" style="font-size:13px">Abra o app do seu banco, escolha <b style="color:var(--text)">Pix → Ler QR Code</b> ou use o código copia-e-cola:</p>
          <div class="pix-code" id="pixCode">${esc(r.pix)}</div>
          <button class="btn" id="copyPix">${icon('copy', 15)}Copiar código Pix</button>
        </div></div>
        <div class="wait" style="margin-top:20px"><span class="spin"></span>Aguardando a confirmação do pagamento… esta tela atualiza sozinha.</div>`
      : `<p class="t2">Pedido criado. A loja ainda não configurou a chave Pix — entre em contato com o suporte informando o código <b class="mono" style="color:var(--text)">${esc(o.code)}</b>.</p>`}
    </div></div>`);
  if (r.pix) {
    try { const q = qrcode(0, 'M'); q.addData(r.pix); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
    catch { $('#qr').innerHTML = '<span style="color:#333;font-size:12px;text-align:center">Use o código copia-e-cola ao lado</span>'; }
    $('#copyPix').onclick = async () => { try { await navigator.clipboard.writeText(r.pix); toast('Código Pix copiado'); } catch { toast('Copie o código manualmente', 'err'); } };
    const poll = setInterval(async () => {
      if (!document.body.contains($('#payBody'))) return clearInterval(poll);
      try {
        const st = await api('GET', '/api/public/orders/' + encodeURIComponent(o.code));
        if (st.status === 'paid' || st.status === 'delivered') {
          clearInterval(poll);
          $('#payBody').innerHTML = `<div class="success"><div class="ok">${icon('check', 26)}</div><h3 style="font-size:20px">Pagamento confirmado</h3>
            <p class="t2" style="margin:8px auto 20px;max-width:380px">Seus itens serão creditados automaticamente na conta <b class="mono" style="color:var(--text)">${esc(st.external_player_id)}</b> na próxima vez que você abrir o jogo.</p>
            <a class="btn" href="/conta">Ver meus pedidos</a></div>`;
        }
      } catch { }
    }, 4000);
  }
}

// ============================================================ autenticação do jogador
function authDialog(after) {
  let mode = 'login';
  const draw = () => {
    const ov = overlay(`<form class="dialog" style="max-width:420px" novalidate>
      <div class="dialog-h"><h3>${mode === 'login' ? 'Entrar na sua conta' : 'Criar conta'}</h3><button type="button" class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
      <div class="dialog-b" style="display:flex;flex-direction:column;gap:14px">${authFields(mode)}<div class="err" id="aErr"></div>
        <button class="btn primary lg" type="submit">${mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
        <p class="t2" style="text-align:center;font-size:13px">${mode === 'login' ? 'Ainda não tem conta?' : 'Já tem conta?'} <a href="#" id="swap" style="color:var(--accent)">${mode === 'login' ? 'Cadastre-se' : 'Entrar'}</a></p>
      </div></form>`);
    $('#swap').onclick = e => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); };
    $('form', ov).onsubmit = async e => {
      e.preventDefault();
      try { await submitAuth(mode, e.target); closeLayer(); await loadMe(); header(); updateCartN(); toast('Bem-vindo, ' + S.me.username); after && after(); }
      catch (err) { $('#aErr').textContent = err.message; }
    };
    $('input', ov).focus();
  };
  draw();
}
const authFields = mode => mode === 'login'
  ? `<label class="field"><span>Usuário ou e-mail</span><input class="input" name="login" autocomplete="username" required></label>
     <label class="field"><span>Senha</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>`
  : `<label class="field"><span>Nome de usuário</span><input class="input" name="username" autocomplete="username" required minlength="3"></label>
     <label class="field"><span>E-mail</span><input class="input" name="email" type="email" autocomplete="email" required></label>
     <label class="field"><span>Senha</span><input class="input" name="password" type="password" autocomplete="new-password" required minlength="8"><small>Mínimo de 8 caracteres.</small></label>`;
async function submitAuth(mode, form) {
  const d = Object.fromEntries(new FormData(form));
  await api('POST', mode === 'login' ? '/api/public/login' : '/api/public/register', { ...d, visitor });
}
async function loadMe() { const r = await api('GET', '/api/public/me'); S.me = r.player; S.links = r.links || []; S.orders = r.orders || []; }

// ============================================================ CONTA
async function account() {
  document.title = 'Minha conta · ' + (S.info.store_name || 'NEXUS');
  track('page_view');
  if (!S.me) {
    $('#main').innerHTML = `<section class="section"><div class="wrap" style="max-width:920px">
      <div class="section-h"><div><span class="label">Conta</span><h2>Acesse sua conta</h2><p>Uma conta para comprar em todos os nossos jogos.</p></div></div>
      <div class="acc">
        <div class="box"><h3>Entrar</h3><p class="t2" style="font-size:13px">Já tenho conta.</p><form id="fLogin">${authFields('login')}<div class="err"></div><button class="btn primary">Entrar</button></form></div>
        <div class="box"><h3>Criar conta</h3><p class="t2" style="font-size:13px">É grátis e leva 10 segundos.</p><form id="fReg">${authFields('register')}<div class="err"></div><button class="btn">Criar conta</button></form></div>
      </div></div></section>`;
    [['#fLogin', 'login'], ['#fReg', 'register']].forEach(([id, mode]) => $(id).onsubmit = async e => {
      e.preventDefault();
      try { await submitAuth(mode, e.target); await loadMe(); header(); account(); }
      catch (err) { $('.err', e.target).textContent = err.message; }
    });
    return;
  }
  $('#main').innerHTML = `<section class="section"><div class="wrap" style="max-width:1000px">
    <div class="section-h"><div><span class="label">Conta</span><h2>Olá, ${esc(S.me.username)}</h2><p>${esc(S.me.email || '')}</p></div><button class="btn" id="logout">${icon('logout', 15)}Sair</button></div>
    ${S.links.length ? `<div class="box" style="margin-bottom:18px"><h3>Contas vinculadas</h3><p class="t2" style="font-size:13px;margin-bottom:12px">IDs de jogador usados nas suas compras.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${S.links.map(l => `<span class="tag">${esc(l.name)} · ${esc(l.external_id)}</span>`).join('')}</div></div>` : ''}
    <div class="box" style="padding:0"><div style="padding:20px 24px 8px"><h3>Meus pedidos</h3></div>
      ${S.orders.length ? `<div class="table-wrap"><table class="table"><thead><tr><th style="padding-left:24px">Pedido</th><th>Jogo</th><th>Data</th><th class="r">Total</th><th style="padding-right:24px">Status</th></tr></thead><tbody>
        ${S.orders.map(o => `<tr><td class="code" style="padding-left:24px">${esc(o.code)}</td><td>${esc(o.game)}</td><td class="t2 mono" style="font-size:12px">${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td class="r">${money(o.total_cents)}</td><td style="padding-right:24px"><span class="status ${o.status}">${STATUS[o.status]}</span></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="t2" style="padding:8px 24px 24px">Você ainda não fez nenhum pedido. <a href="/#jogos" style="color:var(--accent)">Ver jogos</a></p>'}
    </div></div></section>`;
  $('#logout').onclick = async () => { await api('POST', '/api/public/logout'); S.me = null; header(); account(); };
}

function notFound() {
  document.title = 'Página não encontrada';
  $('#main').innerHTML = `<section class="section"><div class="wrap" style="text-align:center;padding:80px 0">
    <span class="label">Erro 404</span><h2 style="font-size:32px;margin:12px 0">Página não encontrada</h2><p class="t2">O endereço que você acessou não existe ou foi removido.</p>
    <a class="btn primary" style="margin-top:24px" href="/">Voltar ao início</a></div></section>`;
}

// ============================================================ boot
(async () => {
  try { S.info = await api('GET', '/api/public/info'); } catch { }
  try { await loadMe(); } catch { }
  header();
  const page = document.body.dataset.page;
  if (page === 'home') { track('page_view'); await home(); }
  else if (page === 'game') await gamePage();
  else if (page === 'account') await account();
  else notFound();
  if (location.hash) $(location.hash)?.scrollIntoView();
})();
