// NEXUS Control — aplicação do painel
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const C = NXChart;

// ============================================================ formatação
const F = {
  money: c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  moneyK: c => { const v = Number(c || 0) / 100; return v >= 10000 ? 'R$ ' + C.compact(v) : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }); },
  int: v => Number(v || 0).toLocaleString('pt-BR'),
  k: v => C.compact(Number(v || 0)),
  pct: v => (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%',
  dt: iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
  day: d => { const [, m, dd] = d.split('-'); return `${dd}/${m}`; },
  dayLong: d => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }),
  ago: iso => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return Math.floor(s) + 's'; if (s < 3600) return Math.floor(s / 60) + 'min';
    if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
  },
};
const L = {
  type: { currency: 'Moeda', skin: 'Skin', item: 'Item', pass: 'Passe', bundle: 'Pacote' },
  typeIcon: { currency: 'coin', skin: 'skin', item: 'item', pass: 'pass', bundle: 'bundle' },
  status: { pending: 'Aguardando pagamento', paid: 'Pago · a entregar', delivered: 'Entregue', refunded: 'Estornado', canceled: 'Cancelado', expired: 'Expirado' },
  verif: { provider: 'Verificado no banco', manual: 'Conferido manualmente', game_signed: 'Loja do jogo · assinado', game_reported: 'Informado pelo jogo', webhook: 'Webhook assinado', none: 'Não verificado' },
  verifIcon: { provider: 'shield', manual: 'check', game_signed: 'shield', game_reported: 'info', webhook: 'check', none: 'alert' },
  gstatus: { live: 'Publicado', beta: 'Beta', dev: 'Em desenvolvimento', paused: 'Pausado' },
  pay: { pix: 'Pix', card: 'Cartão', google_play: 'Google Play', app_store: 'App Store', steam: 'Steam', store: 'Loja do jogo', other: 'Outro' },
  provider: { mercadopago: 'Mercado Pago', manual_pix: 'Pix manual', store: 'Loja da plataforma', admin: 'Registro manual' },
  plat: { web: 'Web', pc: 'PC', android: 'Android', ios: 'iOS', console: 'Console' },
  channel: { site: 'Site', in_game: 'No jogo' },
  event: { download: 'Download', install: 'Instalação', session_start: 'Sessão iniciada', signup: 'Novo cadastro', page_view: 'Acesso ao site' },
};
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

// ============================================================ API
async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'nexus', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && state.me && !url.startsWith('/api/auth')) { state.me = null; toast('Sessão encerrada por inatividade. Entre novamente.', 'err'); boot(); }
    throw new Error(data.error || `Erro ${r.status}`);
  }
  return data;
}

// ============================================================ estado
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const state = {
  me: null, games: [],
  range: (() => { try { return JSON.parse(localStorage.getItem('nx_range')) || { preset: '30' }; } catch { return { preset: '30' }; } })(),
  game: '',
  chart: { type: 'area', metric: 'revenue' },
  orders: { status: '', game: '', channel: '', q: '', page: 1 },
  products: { game: '', type: '', q: '' },
  players: { q: '', page: 1, sort: '' },
};
function rangeDates() {
  const r = state.range;
  if (r.preset === 'custom' && r.from && r.to) return { from: r.from, to: r.to };
  const n = Number(r.preset || 30);
  const to = today();
  return { from: addDays(to, -(n - 1)), to };
}
const gameColor = id => { const i = state.games.findIndex(g => g.id === Number(id)); return SERIES[(i < 0 ? 0 : i) % SERIES.length]; };
const gameHex = id => { const i = state.games.findIndex(g => g.id === Number(id)); return HEX[(i < 0 ? 0 : i) % HEX.length]; };

// ============================================================ UI helpers
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info', 16);
  const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
function closeLayer() { $('#layer').replaceChildren(); C.hideTip(); }
function dialog({ title, body, submit = 'Salvar', onSubmit, wide, danger }) {
  const layer = $('#layer');
  layer.innerHTML = `<div class="overlay"><form class="dialog" style="${wide ? 'max-width:860px' : ''}" novalidate>
    <div class="dialog-h"><h3>${esc(title)}</h3><button type="button" class="btn ghost icon sm x" data-x aria-label="Fechar">${icon('close', 16)}</button></div>
    <div class="dialog-b">${body}</div>
    <div class="dialog-f"><button type="button" class="btn" data-x>Cancelar</button>${onSubmit ? `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(submit)}</button>` : ''}</div>
  </form></div>`;
  const form = $('form', layer);
  $$('[data-x]', layer).forEach(b => b.onclick = closeLayer);
  $('.overlay', layer).addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) closeLayer(); });
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try { if (await onSubmit(formData(form), form) !== false) closeLayer(); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  };
  setTimeout(() => $('input:not([type=hidden]), select, textarea', form)?.focus(), 30);
  return form;
}
function drawer(html) {
  const layer = $('#layer');
  layer.innerHTML = `<div class="overlay drawer-ov"><aside class="drawer">${html}</aside></div>`;
  $('.overlay', layer).addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) closeLayer(); });
  $$('[data-x]', layer).forEach(b => b.onclick = closeLayer);
  return $('.drawer', layer);
}
function formData(form) {
  const d = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (d[el.name] ||= []); if (el.checked) d[el.name].push(el.value); } else d[el.name] = el.checked; }
    else d[el.name] = el.value;
  }
  return d;
}
function confirmDialog(title, text, action = 'Confirmar') {
  return new Promise(res => {
    dialog({ title, body: `<p class="t2">${esc(text)}</p>`, submit: action, danger: true, onSubmit: () => { res(true); } });
    $$('#layer [data-x]').forEach(b => b.addEventListener('click', () => res(false)));
  });
}
// Confirmação forte para ações sensíveis: reautenticação no Firebase (senha ou Google) + 2FA se ativo.
function stepUpDialog({ title, text, action = 'Confirmar', danger = false, fields = '', run }) {
  const layer = $('#layer');
  // conta criada pelo Google não tem senha: mostra só o Google (o servidor informa como a pessoa entrou)
  const google = (window.NXAuth && NXAuth.provider()) ? NXAuth.provider() === 'google.com' : state.me.provider === 'google.com';
  const totp = state.me.totp_enabled;
  layer.innerHTML = `<div class="overlay"><form class="dialog" style="max-width:480px" novalidate>
    <div class="dialog-h"><span style="color:var(--warning);display:flex">${icon('lock', 18)}</span><h3>${esc(title)}</h3><button type="button" class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:14px">
      ${text ? `<p class="t2" style="font-size:13.5px">${esc(text)}</p>` : ''}${fields}
      <div class="stepup"><span class="label">Confirme que é você</span>
        ${totp ? `<label class="field"><span>${google ? '1. ' : ''}Código de 6 dígitos do app autenticador</span><input class="input mono" name="totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" style="letter-spacing:.3em;font-size:18px"><small>Use um código novo — cada código vale uma vez.</small></label>` : ''}
        ${google
          ? `<p class="t2" style="font-size:12.5px">${totp ? '2. ' : ''}Sua conta entra pelo Google. Confirme na janela do Google com a conta <b style="color:var(--text)">${esc(state.me.email)}</b>.</p>`
          : `<label class="field"><span>Senha da conta ${esc(state.me.email)}</span><input class="input" type="password" name="password" autocomplete="current-password"></label>`}
      </div>
      <div class="nxl-msg err" id="suErr" role="alert"></div>
      ${google ? '' : '<a href="#" class="nxl-link" id="useG" style="text-align:left;font-size:12.5px">Entrou com Google? Confirmar com Google</a>'}
    </div>
    <div class="dialog-f"><button type="button" class="btn" data-x>Cancelar</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${google ? icon('globe', 15) + 'Confirmar com Google' : esc(action)}</button></div>
  </form></div>`;
  const form = $('form', layer);
  $$('[data-x]', layer).forEach(b => b.onclick = closeLayer);
  const err = m => { $('#suErr').textContent = m; };
  const go = async useGoogle => {
    const d = formData(form);
    if (totp && !/^\d{6}$/.test(d.totp || '')) { err('Digite o código de 6 dígitos que aparece agora no app autenticador.'); $('[name=totp]', form).focus(); return; }
    if (!useGoogle && !d.password) { err('Digite sua senha.'); return; }
    err('');
    $$('button', form).forEach(b => b.disabled = true);
    try {
      const A = await NXWhenAuth();
      const id_token = await A.freshToken(useGoogle ? { useGoogle: true } : { email: state.me.email, password: d.password });
      await run({ id_token, totp: d.totp }, d);
      if ($('form', layer) === form) closeLayer();
    } catch (e) {
      err(window.NXAuth ? NXAuth.message(e) : e.message);
      $$('button', form).forEach(b => b.disabled = false);
      const t = $('[name=totp]', form); if (t && /código/i.test(e.message)) { t.value = ''; t.focus(); }
    }
  };
  form.onsubmit = e => { e.preventDefault(); go(google); };
  const ug = $('#useG', form); if (ug) ug.onclick = e => { e.preventDefault(); go(true); };
  setTimeout(() => $('input', form)?.focus(), 30);
}
function showSecretOnce(title, secret) {
  const layer = $('#layer');
  layer.innerHTML = `<div class="overlay"><div class="dialog" style="max-width:520px"><div class="dialog-h"><h3>${esc(title)}</h3></div>
    <div class="dialog-b" style="display:flex;flex-direction:column;gap:12px"><p class="t2" style="font-size:13px">Copie agora — por segurança ele não será exibido de novo.</p>
    <div class="keybox"><code id="once">${esc(secret)}</code><button class="btn sm ghost icon" id="onceCopy">${icon('copy', 15)}</button></div></div>
    <div class="dialog-f"><button class="btn primary" data-x>Já copiei</button></div></div></div>`;
  $('#onceCopy').onclick = () => copy(secret);
  $$('[data-x]', layer).forEach(b => b.onclick = () => { closeLayer(); route(); });
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado para a área de transferência', 'ok'); }
  catch { toast('Não foi possível copiar', 'err'); }
}
const gameOptions = (sel, all = 'Todos os jogos') =>
  (all ? `<option value="">${all}</option>` : '') + state.games.map(g => `<option value="${g.id}" ${String(g.id) === String(sel) ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
const pageHead = (idx, title, sub, actions = '') => `
  <div class="page-h"><div><span class="label">${idx}</span><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
const panel = (cls, idx, title, sub, tools, body, bodyCls = '') => `
  <section class="panel ${cls}">
    <div class="panel-h">${idx ? `<span class="idx">${idx}</span>` : ''}<h3>${title}</h3>${sub ? `<span class="sub">${sub}</span>` : ''}${tools ? `<div class="tools">${tools}</div>` : ''}</div>
    <div class="panel-b ${bodyCls}">${body}</div>
  </section>`;
const emptyBox = (ic, title, text, action = '') => `<div class="empty">${icon(ic, 36)}<h3>${title}</h3><p>${text}</p>${action}</div>`;

// filtro de período + jogo (escopo de toda a página)
function filterBar(onChange, { game = true } = {}) {
  const r = state.range, { from, to } = rangeDates();
  const wrap = document.createElement('div');
  wrap.className = 'filters';
  wrap.innerHTML = `
    <span class="t2" style="display:flex">${icon('calendar', 16)}</span>
    <div class="seg" role="group" aria-label="Período">
      ${[['7', '7D'], ['30', '30D'], ['90', '90D'], ['365', '12M'], ['custom', 'Personalizado']].map(([v, l]) => `<button type="button" data-p="${v}" class="${r.preset === v ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="date-pair ${r.preset === 'custom' ? '' : 'hidden'}">
      <input class="input" type="date" id="dFrom" value="${from}" max="${today()}"><span class="muted">→</span><input class="input" type="date" id="dTo" value="${to}" max="${today()}">
    </div>
    ${game ? `<span class="sep"></span><select class="select" id="fGame">${gameOptions(state.game)}</select>` : ''}
    <span class="range-text">${F.day(from)}/${from.slice(2, 4)} — ${F.day(to)}/${to.slice(2, 4)} · UTC−3</span>`;
  const save = () => { try { localStorage.setItem('nx_range', JSON.stringify(state.range)); } catch { } };
  $$('[data-p]', wrap).forEach(b => b.onclick = () => {
    state.range = b.dataset.p === 'custom' ? { preset: 'custom', from, to } : { preset: b.dataset.p };
    save(); onChange();
  });
  const dates = () => {
    const f = $('#dFrom', wrap).value, t = $('#dTo', wrap).value;
    if (f && t && f <= t) { state.range = { preset: 'custom', from: f, to: t }; save(); onChange(); }
  };
  $('#dFrom', wrap).onchange = dates; $('#dTo', wrap).onchange = dates;
  if (game) $('#fGame', wrap).onchange = e => { state.game = e.target.value; onChange(); };
  return wrap;
}

// agrega séries diárias em semanas quando o período é longo
function bucket(days, arrays) {
  if (days.length <= 120) return { labels: days, arrays, unit: 'dia' };
  const labels = [], out = arrays.map(() => []);
  for (let i = 0; i < days.length; i += 7) {
    labels.push(days[i]);
    arrays.forEach((a, k) => out[k].push(a.slice(i, i + 7).reduce((s, v) => s + v, 0)));
  }
  return { labels, arrays: out, unit: 'semana' };
}

function delta(cur, prev, goodUp = true) {
  if (!prev) return `<span class="delta flat">—</span>`;
  const d = (cur - prev) / prev;
  const up = d >= 0, good = up === goodUp;
  if (Math.abs(d) < 0.005) return `<span class="delta flat">0,0%</span>`;
  return `<span class="delta ${good ? 'up' : 'down'}" title="vs. período anterior">${icon(up ? 'arrowUp' : 'arrowDown', 12)}${Math.abs(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>`;
}
function kpiTile(t, k, p, s) {
  return `<section class="panel kpi">
    <div class="k-top">${icon(t.icon, 15)}<span class="label">${t.label}</span></div>
    <div class="k-val" title="${esc(t.full ? t.full(k[t.key]) : '')}">${t.fmt(k[t.key])}</div>
    <div class="k-bot"><div>${delta(k[t.key], p[t.key], t.goodUp !== false)}<span class="vs">vs. ant.</span></div>${s ? C.spark(s, { color: 'var(--accent)', w: 96 }) : ''}</div>
  </section>`;
}

// ============================================================ navegação
const NAV = [
  ['Operação', [
    ['comando', 'Centro de comando', 'command'],
    ['vendas', 'Vendas & receita', 'revenue'],
    ['pagamentos', 'Pagamentos', 'shield'],
    ['audiencia', 'Audiência', 'audience'],
    ['live', 'Ao vivo', 'pulse'],
  ]],
  ['Catálogo', [
    ['jogos', 'Jogos', 'gamepad'],
    ['produtos', 'Produtos', 'box'],
  ]],
  ['Clientes', [
    ['pedidos', 'Pedidos', 'receipt'],
    ['jogadores', 'Jogadores', 'players'],
  ]],
  ['Sistema', [
    ['integracao', 'Integração · API', 'plug'],
    ['seguranca', 'Segurança', 'lock'],
    ['config', 'Configurações', 'sliders'],
  ]],
];
const PAGE_TITLE = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([k, t]) => [k, t])));

function renderNav() {
  const cur = currentRoute();
  $('#nav').innerHTML = NAV.map(([g, items]) => `<div class="rail-group"><span class="label">${g}</span>
    ${items.map(([k, t, ic]) => `<a class="rail-link ${cur === k ? 'on' : ''}" href="#/${k}" title="${t}">${icon(ic, 18)}<span>${t}</span>${k === 'pedidos' ? '<em class="badge hidden" id="pendBadge"></em>' : k === 'pagamentos' ? '<em class="badge hidden" id="reviewBadge"></em>' : ''}</a>`).join('')}
  </div>`).join('');
  $('#crumbs').innerHTML = `<span>NEXUS</span>${icon('chevronRight', 14)}<b>${PAGE_TITLE[cur] || ''}</b>`;
}
function currentRoute() { return (location.hash.match(/^#\/(\w+)/) || [])[1] || 'comando'; }

async function route() {
  const r = currentRoute();
  renderNav();
  closeLayer();
  $('#app').classList.remove('mobile-open');
  const page = $('#page');
  page.scrollTop = 0;
  const fn = PAGES[r] || PAGES.comando;
  try { await fn(page); } catch (e) { console.error(e); page.innerHTML = emptyBox('alert', 'Não foi possível carregar', esc(e.message)); }
  refreshPendingBadge();
}
async function refreshPendingBadge() {
  try {
    const d = await api('GET', '/api/admin/orders?status=paid&size=1');
    const b = $('#pendBadge'); if (!b) return;
    b.textContent = d.total; b.classList.toggle('hidden', !d.total); b.title = 'Pedidos pagos aguardando entrega';
    const rv = await api('GET', '/api/admin/orders?review=1&size=1');
    const rb = $('#reviewBadge'); if (rb) { rb.textContent = rv.total; rb.classList.toggle('hidden', !rv.total); rb.title = 'Pedidos retidos para análise'; }
  } catch { }
}
async function loadGames() { state.games = await api('GET', '/api/admin/games'); }

// ============================================================ PÁGINAS
const PAGES = {};

// ---------------------------------------------------------------- Centro de comando
PAGES.comando = async (page) => {
  if (!state.games.length) {
    page.innerHTML = pageHead('01 · OPERAÇÃO', 'Centro de comando', 'Visão unificada de todos os seus jogos.') +
      `<section class="panel">${emptyBox('gamepad', 'Nenhum jogo cadastrado', 'Cadastre seu primeiro jogo para começar a vender e acompanhar a telemetria, ou gere dados de demonstração para explorar o painel.',
        `<div style="display:flex;gap:8px;justify-content:center"><a class="btn primary" href="#/jogos">${icon('plus', 16)}Cadastrar jogo</a><button class="btn" id="demoBtn">${icon('database', 16)}Gerar dados de demonstração</button></div>`)}</section>`;
    $('#demoBtn').onclick = demoData;
    return;
  }
  page.innerHTML = pageHead('01 · OPERAÇÃO', 'Centro de comando', 'Receita, vendas e telemetria de todos os jogos em tempo real.',
    `<a class="btn" href="/" target="_blank">${icon('external', 15)}Ver site</a><a class="btn" href="/api/admin/export/orders.csv">${icon('download', 15)}Exportar pedidos</a>`);
  page.appendChild(filterBar(() => PAGES.comando(page)));
  const body = document.createElement('div'); body.className = 'loading'; page.appendChild(body);
  const { from, to } = rangeDates();
  const d = await api('GET', `/api/admin/overview?from=${from}&to=${to}&game=${state.game}`);
  body.className = '';
  const k = d.kpis, p = d.prev, s = d.series, b = d.breakdowns, t = d.totals;
  const tiles = [
    { key: 'revenue', label: 'Receita', icon: 'revenue', fmt: F.moneyK, full: F.money, sp: s.revenue },
    { key: 'paid_orders', label: 'Vendas pagas', icon: 'receipt', fmt: F.int, sp: s.orders },
    { key: 'coins', label: 'Moedas vendidas', icon: 'coin', fmt: F.k, full: F.int, sp: s.coins },
    { key: 'aov', label: 'Ticket médio', icon: 'tag', fmt: F.money },
    { key: 'buyers', label: 'Compradores únicos', icon: 'wallet', fmt: F.int },
    { key: 'active_players', label: 'Jogadores ativos', icon: 'gamepad', fmt: F.int, sp: s.active },
    { key: 'downloads', label: 'Downloads', icon: 'download', fmt: F.int, sp: s.downloads },
    { key: 'signups', label: 'Novos cadastros', icon: 'user', fmt: F.int, sp: s.signups },
  ];
  body.innerHTML = `
    <div class="strip">
      <div><span class="label">Receita total</span><b>${F.money(t.revenue)}</b></div>
      <div><span class="label">Moedas vendidas</span><b>${F.int(t.coins)}</b></div>
      <div><span class="label">Pedidos totais</span><b>${F.int(t.orders)}</b></div>
      <div><span class="label">Downloads</span><b>${F.int(t.downloads)}</b></div>
      <div><span class="label">Jogadores únicos</span><b>${F.int(t.players)}</b></div>
      <div><span class="label">Contas criadas</span><b>${F.int(t.accounts)}</b></div>
    </div>
    <div class="kpis">${tiles.map(x => kpiTile(x, k, p, x.sp && x.sp.slice(-Math.min(x.sp.length, 30)))).join('')}</div>
    <div class="grid">
      ${panel('s8', '02', 'Desempenho', '', `
        <div class="seg" id="mMetric">${[['revenue', 'Receita'], ['orders', 'Pedidos'], ['coins', 'Moedas']].map(([v, l]) => `<button data-v="${v}" class="${state.chart.metric === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" id="mType">${[['line', 'Linha'], ['area', 'Área'], ['columns', 'Colunas']].map(([v, l]) => `<button data-v="${v}" class="${state.chart.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>`, '<div id="cMain"></div>')}
      ${panel('s4', '03', 'Receita por jogo', '', '', '<div id="cGames"></div>')}
      ${panel('s8', '04', 'Tráfego & aquisição', 'visitantes, downloads e cadastros por dia', '', '<div id="cTraffic"></div>')}
      ${panel('s4', '05', 'Funil de conversão', '', '', '<div id="cFunnel"></div>')}
      ${panel('s8', '06', 'Horário de compra', 'vendas pagas por dia da semana e hora', '', '<div id="cHeat"></div>')}
      ${panel('s4', '07', 'Atividade recente', '', `<span class="sys-i"><i class="led on"></i><span class="label">ao vivo</span></span>`, '<ul class="feed" id="feed"></ul>', 'flush')}
      ${panel('s8', '08', 'Produtos mais vendidos', '', `<a class="btn sm ghost" href="#/vendas">Detalhes ${icon('chevronRight', 14)}</a>`, '<div class="table-wrap" id="tProducts"></div>', 'flush')}
      ${panel('s4', '09', 'Canal de venda', 'onde o jogador comprou', '', '<div id="cChannel"></div><div style="height:18px"></div><div id="cPay"></div>')}
    </div>`;

  const drawMain = () => {
    const m = state.chart.metric, type = state.chart.type;
    const fmt = m === 'revenue' ? F.money : F.int, fmtY = m === 'revenue' ? (v => 'R$' + C.compact(v / 100)) : C.compact;
    const el = $('#cMain');
    if (m === 'revenue' && type === 'columns') {
      const bk = bucket(s.days, [s.rev_site, s.rev_game]);
      C.columns(el, { labels: bk.labels, series: [{ name: 'Site', values: bk.arrays[0], color: SERIES[0] }, { name: 'No jogo', values: bk.arrays[1], color: SERIES[1] }], fmt, fmtY, fmtX: F.day, fmtTitle: F.dayLong, height: 290 });
    } else {
      const bk = bucket(s.days, [s[m]]);
      const name = { revenue: 'Receita', orders: 'Pedidos', coins: 'Moedas vendidas' }[m];
      const opts = { labels: bk.labels, series: [{ name, values: bk.arrays[0], color: SERIES[0] }], fmt, fmtY, fmtX: F.day, fmtTitle: d => (bk.unit === 'semana' ? 'Semana de ' : '') + F.dayLong(d), height: 290, area: type === 'area' };
      type === 'columns' ? C.columns(el, opts) : C.line(el, opts);
    }
  };
  drawMain();
  $$('#mMetric button').forEach(bt => bt.onclick = () => { state.chart.metric = bt.dataset.v; $$('#mMetric button').forEach(x => x.classList.toggle('on', x === bt)); drawMain(); });
  $$('#mType button').forEach(bt => bt.onclick = () => { state.chart.type = bt.dataset.v; $$('#mType button').forEach(x => x.classList.toggle('on', x === bt)); drawMain(); });

  C.donut($('#cGames'), { segments: b.byGame.map(g => ({ label: g.name, value: g.revenue, color: gameColor(g.id) })), fmt: F.money, centerValue: F.moneyK(k.revenue), centerLabel: 'no período' });
  if (!b.byGame.length) $('#cGames').innerHTML = emptyBox('revenue', 'Sem vendas', 'Nenhuma venda paga no período.');

  const tb = bucket(s.days, [s.visitors, s.downloads, s.signups]);
  C.line($('#cTraffic'), { labels: tb.labels, series: [
    { name: 'Visitantes únicos', values: tb.arrays[0], color: SERIES[0] },
    { name: 'Downloads', values: tb.arrays[1], color: SERIES[1] },
    { name: 'Cadastros', values: tb.arrays[2], color: SERIES[2] }], fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 250 });

  C.funnel($('#cFunnel'), { stages: [
    { label: 'Visitantes do site', value: k.visitors }, { label: 'Downloads', value: k.downloads },
    { label: 'Instalações', value: k.installs }, { label: 'Novos cadastros', value: k.signups }, { label: 'Novos compradores', value: k.new_buyers }], fmt: F.int });

  const days = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const mat = days.map(() => Array(24).fill(0));
  b.heatmap.forEach(c => { mat[(c.dow + 6) % 7][c.hour] = c.orders; });
  C.heatmap($('#cHeat'), { rows: days, cols: [...Array(24).keys()].map(h => String(h).padStart(2, '0') + 'h'), values: mat, fmt: F.int, unit: 'vendas pagas', cellMax: 40 });

  const maxRev = Math.max(1, ...b.byProduct.map(x => x.revenue));
  $('#tProducts').innerHTML = b.byProduct.length ? `<table class="table"><thead><tr><th>Produto</th><th>Jogo</th><th class="r">Qtd.</th><th class="r">Moedas</th><th style="width:28%">Receita</th></tr></thead><tbody>
    ${b.byProduct.slice(0, 8).map(x => `<tr><td><div class="cell-main"><span class="pi ${x.type}">${icon(L.typeIcon[x.type], 16)}</span><div><b>${esc(x.name)}</b><small>${esc(x.sku)}</small></div></div></td>
      <td class="t2">${esc(x.game)}</td><td class="r">${F.int(x.qty)}</td><td class="r">${x.coins ? F.int(x.coins) : '<span class="muted">—</span>'}</td>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="viz-bars-track" style="flex:1"><div class="viz-bars-fill" style="width:${(x.revenue / maxRev) * 100}%;background:var(--series-1)"></div></div><b class="num" style="min-width:92px;text-align:right;font-weight:600">${F.money(x.revenue)}</b></div></td></tr>`).join('')}
    </tbody></table>` : emptyBox('box', 'Sem vendas', 'Nenhum produto vendido no período.');

  C.bars($('#cChannel'), { rows: b.byChannel.map((c, i) => ({ label: L.channel[c.key] || c.key, sub: F.int(c.orders) + ' pedidos', value: c.revenue, color: SERIES[i] })), fmt: F.money });
  C.bars($('#cPay'), { rows: b.byPayment.map(c => ({ label: L.pay[c.key] || c.key, sub: F.int(c.orders), value: c.revenue, color: 'var(--series-1)' })), fmt: F.money });

  loadFeed($('#feed'));
};

async function loadFeed(ul, limit = 14) {
  const items = await api('GET', '/api/admin/feed?limit=' + limit);
  ul.innerHTML = items.map(feedItem).join('') || `<li><span></span><span class="muted">Sem atividade ainda.</span></li>`;
}
function feedItem(x, isNew) {
  if (x.kind === 'order') {
    return `<li class="${isNew ? 'new' : ''}"><span class="fi order">${icon('receipt', 14)}</span>
      <div class="ft"><b>${x.status === 'pending' ? 'Pedido criado' : 'Venda'} · ${esc(x.game)}</b><span>${esc(x.code)} · ${L.channel[x.channel] || ''}${x.coins_total ? ' · ' + F.int(x.coins_total) + ' moedas' : ''}</span></div>
      <div class="fr"><b>${F.money(x.total_cents)}</b>${F.ago(x.at)}</div></li>`;
  }
  const ic = { download: 'download', install: 'monitor', session_start: 'play', signup: 'user' }[x.type] || 'pulse';
  return `<li class="${isNew ? 'new' : ''}"><span class="fi">${icon(ic, 14)}</span>
    <div class="ft"><b>${L.event[x.type] || x.type}</b><span>${esc(x.game || 'Site')}${x.platform ? ' · ' + (L.plat[x.platform] || x.platform) : ''}</span></div>
    <div class="fr">${F.ago(x.at)}</div></li>`;
}

// ---------------------------------------------------------------- Vendas
PAGES.vendas = async (page) => {
  page.innerHTML = pageHead('02 · OPERAÇÃO', 'Vendas & receita', 'Quanto foi vendido, quantas moedas saíram e quanto você apurou.',
    `<a class="btn" href="/api/admin/export/orders.csv">${icon('download', 15)}Exportar CSV</a>`);
  page.appendChild(filterBar(() => PAGES.vendas(page)));
  const body = document.createElement('div'); body.className = 'loading'; page.appendChild(body);
  const { from, to } = rangeDates();
  const scope = state.game ? state.games.filter(g => String(g.id) === state.game) : state.games;
  const [all, ...per] = await Promise.all([
    api('GET', `/api/admin/overview?from=${from}&to=${to}&game=${state.game}`),
    ...scope.map(g => api('GET', `/api/admin/overview?from=${from}&to=${to}&game=${g.id}`)),
  ]);
  body.className = '';
  const k = all.kpis, p = all.prev, b = all.breakdowns, s = all.series;
  const net = { revenue: k.revenue - k.refunds }, netP = { revenue: p.revenue - p.refunds };
  const tiles = [
    { key: 'revenue', label: 'Receita bruta', icon: 'revenue', fmt: F.money },
    { key: 'refunds', label: 'Estornos', icon: 'refresh', fmt: F.money, goodUp: false },
    { key: 'paid_orders', label: 'Vendas pagas', icon: 'receipt', fmt: F.int },
    { key: 'coins', label: 'Moedas vendidas', icon: 'coin', fmt: F.int },
    { key: 'items', label: 'Itens vendidos', icon: 'box', fmt: F.int },
    { key: 'arppu', label: 'Gasto médio por comprador', icon: 'wallet', fmt: F.money },
    { key: 'pending', label: 'Aguardando pagamento', icon: 'alert', fmt: F.int, goodUp: false },
    { key: 'to_deliver', label: 'Pagos a entregar', icon: 'send', fmt: F.int, goodUp: false },
  ];
  body.innerHTML = `
    <div class="strip">
      <div><span class="label">Receita líquida</span><b>${F.money(net.revenue)}</b></div>
      <div><span class="label">Verificada no banco/loja</span><b>${F.money(k.verified_revenue)}</b></div>
      <div><span class="label">vs. período anterior</span><b>${delta(net.revenue, netP.revenue)}</b></div>
      ${per.map((x, i) => `<div><span class="label">${esc(scope[i].name)} · ${esc(scope[i].currency_name)}</span><b>${F.int(x.kpis.coins)}</b></div>`).join('')}
    </div>
    <div class="kpis">${tiles.map(t => kpiTile(t, k, p)).join('')}</div>
    <div class="grid">
      ${panel('s12', '01', 'Receita por jogo', 'evolução diária', '', '<div id="vRevGames"></div>')}
      ${panel('s8', '02', 'Moedas vendidas por jogo', 'volume de moeda virtual entregue', '', '<div id="vCoins"></div>')}
      ${panel('s4', '03', 'Receita por tipo de produto', '', '', '<div id="vType"></div>')}
      ${panel('s4', '04', 'Plataforma', '', '', '<div id="vPlat"></div>')}
      ${panel('s4', '05', 'Forma de pagamento', '', '', '<div id="vPay"></div>')}
      ${panel('s4', '06', 'Status dos pedidos', 'todos os pedidos do período', '', '<div id="vStatus"></div>')}
      ${panel('s12', '07', 'Ranking de produtos', '', '', '<div class="table-wrap" id="vProducts"></div>', 'flush')}
      ${panel('s8', '08', 'Quem mais comprou', 'compradores do período', `<a class="btn sm ghost" href="#/jogadores" id="allBuyers">Todos ${icon('chevronRight', 14)}</a>`, '<div class="table-wrap" id="vBuyers"></div>', 'flush')}
      ${panel('s4', '09', 'Como a receita foi verificada', '', '', '<div id="vVerif"></div>')}
    </div>`;
  const bk = bucket(s.days, per.map(x => x.series.revenue));
  C.line($('#vRevGames'), { labels: bk.labels, series: scope.map((g, i) => ({ name: g.name, values: bk.arrays[i], color: gameColor(g.id) })), fmt: F.money, fmtY: v => 'R$' + C.compact(v / 100), fmtX: F.day, fmtTitle: F.dayLong, height: 280, area: scope.length === 1 });
  const ck = bucket(s.days, per.map(x => x.series.coins));
  C.columns($('#vCoins'), { labels: ck.labels, series: scope.map((g, i) => ({ name: `${g.name} (${g.currency_name})`, values: ck.arrays[i], color: gameColor(g.id) })), fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 260 });
  C.donut($('#vType'), { segments: b.byType.map((x, i) => ({ label: L.type[x.key] || x.key, value: x.revenue, color: SERIES[i] })), fmt: F.money, centerValue: F.moneyK(k.revenue) });
  C.donut($('#vPlat'), { segments: b.byPlatform.map((x, i) => ({ label: L.plat[x.key] || x.key, value: x.revenue, color: SERIES[i] })), fmt: F.money, centerValue: F.moneyK(k.revenue) });
  C.bars($('#vPay'), { rows: b.byPayment.map(x => ({ label: L.pay[x.key] || x.key, sub: F.int(x.orders) + ' pedidos', value: x.revenue })), fmt: F.money });
  $('#vBuyers').innerHTML = b.topBuyers.length ? `<table class="table"><thead><tr><th>#</th><th>Jogador</th><th class="r">Compras</th><th class="r">Moedas</th><th>Última</th><th class="r">Total gasto</th></tr></thead><tbody>
    ${b.topBuyers.map((x, i) => `<tr class="row-link" data-pid="${x.id}"><td class="muted mono">${String(i + 1).padStart(2, '0')}</td><td><div class="cell-main"><span class="pi">${icon('user', 15)}</span><div><b>${esc(x.username)}</b><small>${esc(x.email || 'conta do jogo')}</small></div></div></td>
      <td class="r">${F.int(x.orders)}</td><td class="r">${F.int(x.coins)}</td><td class="t2">há ${F.ago(x.last)}</td><td class="r"><b style="font-weight:600">${F.money(x.spent)}</b></td></tr>`).join('')}</tbody></table>`
    : emptyBox('players', 'Sem compradores', 'Nenhuma compra paga no período.');
  $$('#vBuyers [data-pid]').forEach(tr => tr.onclick = () => playerDrawer(Number(tr.dataset.pid)));
  $('#allBuyers').onclick = () => { state.players = { q: '', page: 1, sort: 'spent' }; };
  const vColor = { provider: 'var(--good)', game_signed: 'var(--series-3)', manual: 'var(--accent)', webhook: 'var(--series-7)', game_reported: 'var(--warning)', none: 'var(--muted)' };
  C.bars($('#vVerif'), { rows: b.byVerification.map(x => ({ label: L.verif[x.key] || x.key, sub: F.int(x.orders) + ' pedidos', value: x.revenue, color: vColor[x.key] })), fmt: F.money });
  const stOrder = ['delivered', 'paid', 'pending', 'refunded', 'canceled', 'expired'];
  const stColor = { delivered: 'var(--good)', paid: 'var(--accent)', pending: 'var(--warning)', refunded: 'var(--serious)', canceled: 'var(--critical)', expired: 'var(--muted)' };
  C.bars($('#vStatus'), { rows: stOrder.map(st => b.byStatus.find(x => x.key === st)).filter(Boolean).map(x => ({ label: L.status[x.key], sub: F.money(x.revenue), value: x.orders, color: stColor[x.key] })), fmt: F.int });
  const maxRev = Math.max(1, ...b.byProduct.map(x => x.revenue));
  const totalRev = b.byProduct.reduce((a, x) => a + x.revenue, 0) || 1;
  $('#vProducts').innerHTML = `<table class="table"><thead><tr><th>#</th><th>Produto</th><th>Jogo</th><th>Tipo</th><th class="r">Unidades</th><th class="r">Moedas</th><th class="r">% receita</th><th style="width:24%">Receita</th></tr></thead><tbody>
    ${b.byProduct.map((x, i) => `<tr><td class="muted mono">${String(i + 1).padStart(2, '0')}</td>
      <td><div class="cell-main"><span class="pi ${x.type}">${icon(L.typeIcon[x.type], 16)}</span><div><b>${esc(x.name)}</b><small>${esc(x.sku)}</small></div></div></td>
      <td class="t2">${esc(x.game)}</td><td><span class="tag">${L.type[x.type]}</span></td><td class="r">${F.int(x.qty)}</td>
      <td class="r">${x.coins ? F.int(x.coins) : '<span class="muted">—</span>'}</td><td class="r mono t2">${F.pct(x.revenue / totalRev)}</td>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="viz-bars-track" style="flex:1"><div class="viz-bars-fill" style="width:${(x.revenue / maxRev) * 100}%;background:var(--series-1)"></div></div><b class="num" style="min-width:92px;text-align:right;font-weight:600">${F.money(x.revenue)}</b></div></td></tr>`).join('')}
  </tbody></table>`;
};

// ---------------------------------------------------------------- Audiência
PAGES.audiencia = async (page) => {
  page.innerHTML = pageHead('04 · OPERAÇÃO', 'Audiência', 'Acessos ao site, downloads, cadastros e jogadores ativos em cada jogo.');
  page.appendChild(filterBar(() => PAGES.audiencia(page)));
  const body = document.createElement('div'); body.className = 'loading'; page.appendChild(body);
  const { from, to } = rangeDates();
  const scope = state.game ? state.games.filter(g => String(g.id) === state.game) : state.games;
  const [all, ...per] = await Promise.all([
    api('GET', `/api/admin/overview?from=${from}&to=${to}&game=${state.game}`),
    ...scope.map(g => api('GET', `/api/admin/overview?from=${from}&to=${to}&game=${g.id}`)),
  ]);
  body.className = '';
  const k = all.kpis, p = all.prev, s = all.series, b = all.breakdowns;
  k.spp = k.active_players ? k.sessions / k.active_players : 0; p.spp = p.active_players ? p.sessions / p.active_players : 0;
  const tiles = [
    { key: 'views', label: 'Visualizações', icon: 'eye', fmt: F.int },
    { key: 'visitors', label: 'Visitantes únicos', icon: 'globe', fmt: F.int },
    { key: 'downloads', label: 'Downloads', icon: 'download', fmt: F.int },
    { key: 'installs', label: 'Instalações', icon: 'monitor', fmt: F.int },
    { key: 'signups', label: 'Novos cadastros', icon: 'user', fmt: F.int },
    { key: 'active_players', label: 'Jogadores ativos', icon: 'gamepad', fmt: F.int },
    { key: 'sessions', label: 'Sessões de jogo', icon: 'play', fmt: F.int },
    { key: 'spp', label: 'Sessões por jogador', icon: 'signal', fmt: v => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) },
  ];
  body.innerHTML = `
    <div class="kpis">${tiles.map(t => kpiTile(t, k, p)).join('')}</div>
    <div class="grid">
      ${panel('s8', '01', 'Acessos ao site', 'visualizações de página e visitantes únicos', '', '<div id="aViews"></div>')}
      ${panel('s4', '02', 'Origem dos visitantes', 'por país', '', '<div id="aCountry"></div>')}
      ${panel('s6', '03', 'Downloads por jogo', '', '', '<div id="aDl"></div>')}
      ${panel('s6', '04', 'Jogadores ativos por dia', 'jogadores únicos com sessão no dia', '', '<div id="aActive"></div>')}
      ${panel('s6', '05', 'Novos cadastros', 'contas criadas no site e nos jogos', '', '<div id="aSign"></div>')}
      ${panel('s6', '06', 'Comparativo entre jogos', '', '', '<div class="table-wrap" id="aGames"></div>', 'flush')}
    </div>`;
  const vb = bucket(s.days, [s.views, s.visitors]);
  C.line($('#aViews'), { labels: vb.labels, series: [{ name: 'Visualizações', values: vb.arrays[0], color: SERIES[0] }, { name: 'Visitantes únicos', values: vb.arrays[1], color: SERIES[2] }], fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 270, area: true });
  const total = b.countries.reduce((a, c) => a + c.visitors, 0) || 1;
  const CN = { BR: 'Brasil', PT: 'Portugal', AR: 'Argentina', US: 'Estados Unidos', MX: 'México', CL: 'Chile', AO: 'Angola' };
  C.bars($('#aCountry'), { rows: b.countries.map(c => ({ label: CN[c.key] || c.key || '—', sub: F.pct(c.visitors / total), value: c.visitors })), fmt: F.int });
  const db = bucket(s.days, per.map(x => x.series.downloads));
  C.columns($('#aDl'), { labels: db.labels, series: scope.map((g, i) => ({ name: g.name, values: db.arrays[i], color: gameColor(g.id) })), fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 240 });
  const ab = bucket(s.days, per.map(x => x.series.active));
  C.line($('#aActive'), { labels: ab.labels, series: scope.map((g, i) => ({ name: g.name, values: ab.arrays[i], color: gameColor(g.id) })), fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 240, area: scope.length === 1 });
  const sb = bucket(s.days, [s.signups]);
  C.columns($('#aSign'), { labels: sb.labels, series: [{ name: 'Cadastros', values: sb.arrays[0], color: SERIES[2] }], fmt: F.int, fmtX: F.day, fmtTitle: F.dayLong, height: 240 });
  $('#aGames').innerHTML = `<table class="table"><thead><tr><th>Jogo</th><th class="r">Downloads</th><th class="r">Cadastros</th><th class="r">Ativos</th><th class="r">Sessões</th><th class="r">Conversão*</th></tr></thead><tbody>
    ${per.map((x, i) => `<tr><td><span style="display:inline-flex;align-items:center;gap:8px"><span class="viz-key rect" style="background:${gameColor(scope[i].id)}"></span>${esc(scope[i].name)}</span></td>
      <td class="r">${F.int(x.kpis.downloads)}</td><td class="r">${F.int(x.kpis.signups)}</td><td class="r">${F.int(x.kpis.active_players)}</td><td class="r">${F.int(x.kpis.sessions)}</td>
      <td class="r mono">${x.kpis.active_players ? F.pct(x.kpis.buyers / x.kpis.active_players) : '—'}</td></tr>`).join('')}
    </tbody></table><div class="panel-f">* compradores ÷ jogadores ativos no período</div>`;
};

// ---------------------------------------------------------------- Ao vivo
const live = { buckets: [], counts: { order: 0, download: 0, signup: 0, session_start: 0, revenue: 0 } };
PAGES.live = async (page) => {
  page.innerHTML = pageHead('05 · OPERAÇÃO', 'Ao vivo', 'Eventos chegando dos jogos e do site, em tempo real.') + `
    <div class="kpis">
      ${[['order', 'Vendas nesta sessão', 'receipt'], ['revenue', 'Receita nesta sessão', 'revenue'], ['session_start', 'Sessões iniciadas', 'play'], ['download', 'Downloads', 'download']].map(([k, l, ic]) =>
        `<section class="panel kpi"><div class="k-top">${icon(ic, 15)}<span class="label">${l}</span></div><div class="k-val" id="lv_${k}">${k === 'revenue' ? F.money(live.counts[k]) : F.int(live.counts[k])}</div><div class="k-bot"><span class="muted" style="font-size:11.5px">desde que você abriu o painel</span></div></section>`).join('')}
    </div>
    <div class="grid">
      ${panel('s8', '01', 'Eventos por minuto', 'últimos 30 minutos', '', '<div id="lvChart"></div>')}
      ${panel('s4', '02', 'Conexão', '', '', `<dl class="kv"><dt>Stream</dt><dd><span class="status ${streamOk ? 'delivered' : 'canceled'}" id="lvConn">${streamOk ? 'Conectado' : 'Desconectado'}</span></dd>
        <dt>Endpoint</dt><dd class="mono">/api/admin/stream</dd><dt>Origem</dt><dd class="t2">API dos jogos (v1) e site público</dd></dl>
        <p class="muted" style="margin-top:16px;font-size:12.5px">Para testar, use o console em <a href="#/integracao" style="color:var(--accent)">Integração · API</a> e envie uma compra simulada.</p>`)}
      ${panel('s12', '03', 'Fluxo de eventos', '', '', '<ul class="feed" id="lvFeed" style="max-height:520px"></ul>', 'flush')}
    </div>`;
  drawLive();
  loadFeed($('#lvFeed'), 40);
};
function liveTick(type, data) {
  const m = Math.floor(Date.now() / 60000);
  let b = live.buckets.find(x => x.m === m);
  if (!b) { b = { m, order: 0, other: 0 }; live.buckets.push(b); live.buckets = live.buckets.slice(-30); }
  if (type === 'order') { b.order++; live.counts.order++; live.counts.revenue += data.total_cents || 0; }
  else { b.other++; if (data.type in live.counts) live.counts[data.type]++; }
  if (currentRoute() === 'live') {
    for (const k in live.counts) { const el = $('#lv_' + k); if (el) el.textContent = k === 'revenue' ? F.money(live.counts[k]) : F.int(live.counts[k]); }
    clearTimeout(liveTick.t); liveTick.t = setTimeout(drawLive, 400);
  }
}
function drawLive() {
  const el = $('#lvChart'); if (!el) return;
  const m = Math.floor(Date.now() / 60000);
  const mins = [...Array(30).keys()].map(i => m - 29 + i);
  const get = (mm, k) => live.buckets.find(x => x.m === mm)?.[k] || 0;
  C.columns(el, { labels: mins, series: [{ name: 'Pedidos', values: mins.map(x => get(x, 'order')), color: SERIES[0] }, { name: 'Telemetria', values: mins.map(x => get(x, 'other')), color: SERIES[2] }],
    fmt: F.int, fmtX: mm => new Date(mm * 60000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), height: 240 });
}

// ---------------------------------------------------------------- Jogos
PAGES.jogos = async (page) => {
  await loadGames();
  page.innerHTML = pageHead('06 · CATÁLOGO', 'Jogos', 'Seus jogos publicados no site, com página de download e loja própria.',
    `<button class="btn primary" id="newGame">${icon('plus', 16)}Novo jogo</button>`) +
    (state.games.length ? `<div class="games">${state.games.map(g => `
      <section class="panel game-card">
        <div class="cover">${coverSVG(g, { title: false })}<div class="cover-meta"><span class="tag">${esc(g.genre || 'Jogo')}</span><span class="tag">v${esc(g.version)}</span></div></div>
        <div class="gc-b">
          <div class="gc-title"><div><h3>${esc(g.name)}</h3><p>${esc(g.tagline || '')}</p></div><span class="status ${g.status}">${L.gstatus[g.status]}</span></div>
          <div class="gc-stats">
            <div><span class="label">Receita</span><b>${F.moneyK(g.revenue)}</b></div>
            <div><span class="label">${esc(g.currency_name)}</span><b>${F.k(g.coins)}</b></div>
            <div><span class="label">Downloads</span><b>${F.int(g.downloads)}</b></div>
            <div><span class="label">Jogadores</span><b>${F.int(g.players)}</b></div>
          </div>
          <div class="gc-actions">
            <button class="btn sm" data-edit="${g.id}">${icon('edit', 14)}Editar</button>
            <a class="btn sm" href="#/produtos" data-prod="${g.id}">${icon('box', 14)}${g.products} produtos</a>
            <a class="btn sm" href="#/integracao" data-int="${g.id}">${icon('key', 14)}API</a>
            <a class="btn sm ghost icon" style="margin-left:auto" href="/jogo/${esc(g.slug)}" target="_blank" title="Abrir página pública">${icon('external', 15)}</a>
          </div>
        </div>
      </section>`).join('')}</div>`
      : `<section class="panel">${emptyBox('gamepad', 'Nenhum jogo ainda', 'Cadastre seu primeiro jogo. Ele ganha uma página pública com download e loja, e uma chave de API para integrar as compras.', `<button class="btn primary" id="newGame2">${icon('plus', 16)}Novo jogo</button>`)}</section>`);
  $('#newGame').onclick = () => gameForm();
  if ($('#newGame2')) $('#newGame2').onclick = () => gameForm();
  $$('[data-edit]', page).forEach(b => b.onclick = () => gameForm(state.games.find(g => g.id === Number(b.dataset.edit))));
  $$('[data-prod]', page).forEach(a => a.onclick = () => { state.products.game = a.dataset.prod; });
  $$('[data-int]', page).forEach(a => a.onclick = () => { state.intGame = a.dataset.int; });
};
function gameForm(g = {}) {
  const plats = g.platforms || ['pc'];
  dialog({
    title: g.id ? `Editar · ${g.name}` : 'Novo jogo', wide: true, submit: g.id ? 'Salvar alterações' : 'Cadastrar jogo',
    body: `<div class="form-grid">
      <label class="field"><span>Nome do jogo *</span><input class="input" name="name" required value="${esc(g.name)}"></label>
      <label class="field"><span>Endereço da página</span><input class="input mono" name="slug" placeholder="gerado a partir do nome" value="${esc(g.slug)}"><small>/jogo/<b>${esc(g.slug || 'meu-jogo')}</b></small></label>
      <label class="field full"><span>Chamada (tagline)</span><input class="input" name="tagline" maxlength="140" value="${esc(g.tagline)}"></label>
      <label class="field full"><span>Descrição</span><textarea class="textarea" name="description" rows="4">${esc(g.description)}</textarea></label>
      <label class="field"><span>Gênero</span><input class="input" name="genre" value="${esc(g.genre)}" placeholder="RPG, FPS, Corrida…"></label>
      <label class="field"><span>Status</span><select class="select" name="status">${Object.entries(L.gstatus).map(([k, v]) => `<option value="${k}" ${g.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Versão atual</span><input class="input mono" name="version" value="${esc(g.version || '1.0.0')}"></label>
      <label class="field"><span>Nome da moeda do jogo</span><input class="input" name="currency_name" value="${esc(g.currency_name || 'Moedas')}" placeholder="Moedas, Gemas, Créditos…"></label>
      <div class="field full"><span>Plataformas</span><div class="chips">${Object.entries(L.plat).filter(([k]) => k !== 'web' || true).map(([k, v]) =>
        `<label class="chip-check"><input type="checkbox" name="platforms" data-multi="1" value="${k}" ${plats.includes(k) ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
      <label class="field full"><span>Link de download</span><input class="input mono" name="download_url" value="${esc(g.download_url)}" placeholder="https://… (itch.io, Google Drive, Steam, Play Store, arquivo próprio)"></label>
      <label class="field"><span>Imagem de capa (URL, opcional)</span><input class="input mono" name="cover_url" value="${esc(g.cover_url)}" placeholder="sem imagem = capa gerada"></label>
      <label class="field"><span>Cor de destaque</span><input class="input" type="color" name="accent" value="${esc(g.accent || '#3987e5')}" style="padding:3px;height:36px"></label>
    </div>
    ${g.id ? `<div class="section-t"><span class="label">Zona de risco</span></div><button type="button" class="btn danger sm" id="delGame">${icon('trash', 14)}Excluir jogo e todos os dados</button>` : ''}`,
    onSubmit: async d => {
      const saved = g.id ? await api('PUT', '/api/admin/games/' + g.id, d) : await api('POST', '/api/admin/games', d);
      toast(g.id ? 'Jogo atualizado' : `Jogo "${saved.name}" cadastrado`, 'ok');
      await loadGames(); route();
    },
  });
  const del = $('#delGame');
  if (del) del.onclick = async () => {
    stepUpDialog({ title: 'Excluir jogo', text: `Excluir "${g.name}" apaga também produtos, pedidos e telemetria dele. Isso não pode ser desfeito.`, action: 'Excluir definitivamente', danger: true,
      run: async ex => { await api('DELETE', '/api/admin/games/' + g.id, ex); toast('Jogo excluído', 'ok'); await loadGames(); route(); } });
  };
}

// ---------------------------------------------------------------- Produtos
PAGES.produtos = async (page) => {
  const f = state.products;
  const list = await api('GET', '/api/admin/products' + (f.game ? '?game=' + f.game : ''));
  let rows = list;
  if (f.type) rows = rows.filter(p => p.type === f.type);
  if (f.q) rows = rows.filter(p => (p.name + ' ' + p.sku).toLowerCase().includes(f.q.toLowerCase()));
  page.innerHTML = pageHead('07 · CATÁLOGO', 'Produtos', 'Pacotes de moedas, skins, itens e passes vendidos no site e dentro dos jogos.',
    state.games.length ? `<button class="btn primary" id="newProd">${icon('plus', 16)}Novo produto</button>` : '') + `
    <div class="filters">
      <select class="select" id="pGame">${gameOptions(f.game)}</select>
      <div class="seg" id="pType"><button data-v="" class="${!f.type ? 'on' : ''}">Todos</button>${Object.entries(L.type).map(([k, v]) => `<button data-v="${k}" class="${f.type === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="input-group">${icon('search', 15)}<input class="input" id="pQ" placeholder="Buscar por nome ou SKU" value="${esc(f.q)}"></div>
    </div>
    <section class="panel"><div class="panel-b flush"><div class="table-wrap">
      ${rows.length ? `<table class="table"><thead><tr><th>Produto</th><th>Jogo</th><th>Tipo</th><th class="r">Preço</th><th class="r">Moedas</th><th class="r">Estoque</th><th class="r">Vendidos</th><th class="r">Receita</th><th>À venda</th><th></th></tr></thead><tbody>
        ${rows.map(p => `<tr>
          <td><div class="cell-main"><span class="pi ${p.type}">${icon(L.typeIcon[p.type], 16)}</span><div><b>${esc(p.name)}${p.featured ? ` <span style="color:var(--warning);display:inline-block;vertical-align:-2px">${icon('star', 12)}</span>` : ''}</b><small>${esc(p.sku)}</small></div></div></td>
          <td class="t2">${esc(p.game_name)}</td><td><span class="tag">${L.type[p.type]}</span></td>
          <td class="r"><b style="font-weight:600">${F.money(p.price_cents)}</b>${p.compare_cents ? `<span class="strike">${F.money(p.compare_cents)}</span>` : ''}</td>
          <td class="r">${p.coins ? F.int(p.coins) : '<span class="muted">—</span>'}</td>
          <td class="r">${p.stock == null ? '<span class="muted">∞</span>' : p.stock <= 20 ? `<span style="color:var(--warning)">${F.int(p.stock)}</span>` : F.int(p.stock)}</td>
          <td class="r">${F.int(p.sold)}</td><td class="r">${F.money(p.revenue)}</td>
          <td><label class="switch"><input type="checkbox" data-toggle="${p.id}" ${p.active ? 'checked' : ''} aria-label="À venda"></label></td>
          <td class="r" style="white-space:nowrap"><button class="btn sm ghost icon" data-edit="${p.id}" title="Editar">${icon('edit', 15)}</button><button class="btn sm ghost icon" data-dup="${p.id}" title="Duplicar">${icon('copy', 15)}</button><button class="btn sm ghost icon danger" data-del="${p.id}" title="Excluir">${icon('trash', 15)}</button></td>
        </tr>`).join('')}</tbody></table>`
        : emptyBox('box', state.games.length ? 'Nenhum produto encontrado' : 'Cadastre um jogo primeiro', state.games.length ? 'Crie pacotes de moedas, skins ou passes para vender.' : 'Produtos pertencem a um jogo.')}
    </div></div><div class="panel-f"><span>${rows.length} produto(s)</span><span class="mono">SKU = identificador usado pela API do jogo</span></div></section>`;
  const re = () => PAGES.produtos(page);
  $('#newProd') && ($('#newProd').onclick = () => productForm({ game_id: f.game || state.games[0]?.id }));
  $('#pGame').onchange = e => { f.game = e.target.value; re(); };
  $$('#pType button').forEach(b => b.onclick = () => { f.type = b.dataset.v; re(); });
  $('#pQ').oninput = e => { f.q = e.target.value; clearTimeout(re.t); re.t = setTimeout(async () => { await re(); const i = $('#pQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  $$('[data-edit]', page).forEach(b => b.onclick = () => productForm(list.find(p => p.id === Number(b.dataset.edit))));
  $$('[data-dup]', page).forEach(b => b.onclick = async () => {
    const { id, sku, ...p } = list.find(x => x.id === Number(b.dataset.dup));
    await api('POST', '/api/admin/products', { ...p, sku: sku + '_COPIA', name: p.name + ' (cópia)', active: false });
    toast('Produto duplicado (oculto até você ativar)', 'ok'); re();
  });
  $$('[data-del]', page).forEach(b => b.onclick = async () => {
    const p = list.find(x => x.id === Number(b.dataset.del));
    if (!(await confirmDialog('Excluir produto', `Excluir "${p.name}"? Pedidos antigos continuam registrados.`, 'Excluir'))) return;
    await api('DELETE', '/api/admin/products/' + p.id); toast('Produto excluído', 'ok'); re();
  });
  $$('[data-toggle]', page).forEach(c => c.onchange = async () => {
    try { await api('PUT', '/api/admin/products/' + c.dataset.toggle, { active: c.checked }); toast(c.checked ? 'Produto à venda' : 'Produto oculto da loja', 'ok'); }
    catch (e) { toast(e.message, 'err'); c.checked = !c.checked; }
  });
};
function productForm(p = {}) {
  const reais = c => (c == null || c === '' ? '' : (c / 100).toFixed(2));
  dialog({
    title: p.id ? 'Editar produto' : 'Novo produto', submit: p.id ? 'Salvar' : 'Criar produto',
    body: `<div class="form-grid">
      <label class="field"><span>Jogo *</span><select class="select" name="game_id">${gameOptions(p.game_id, '')}</select></label>
      <label class="field"><span>Tipo</span><select class="select" name="type">${Object.entries(L.type).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field full"><span>Nome *</span><input class="input" name="name" required value="${esc(p.name)}" placeholder="Ex.: 1.200 Créditos"></label>
      <label class="field"><span>SKU</span><input class="input mono" name="sku" value="${esc(p.sku)}" placeholder="CR_1200"><small>O jogo usa este código para comprar o item.</small></label>
      <label class="field"><span>Moedas entregues</span><input class="input" type="number" min="0" name="coins" value="${p.coins ?? 0}"><small>Para pacotes de moeda virtual.</small></label>
      <label class="field"><span>Preço (R$) *</span><input class="input" type="number" min="0" step="0.01" name="price" required value="${reais(p.price_cents)}"></label>
      <label class="field"><span>Preço “de” (promoção)</span><input class="input" type="number" min="0" step="0.01" name="compare" value="${reais(p.compare_cents)}"></label>
      <label class="field"><span>Estoque</span><input class="input" type="number" min="0" name="stock" value="${p.stock ?? ''}" placeholder="vazio = ilimitado"></label>
      <label class="field"><span>Imagem (URL, opcional)</span><input class="input mono" name="image_url" value="${esc(p.image_url)}"></label>
      <label class="field full"><span>Descrição</span><textarea class="textarea" name="description" rows="2">${esc(p.description)}</textarea></label>
      <div class="full" style="display:flex;gap:24px"><label class="switch"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''}> À venda</label><label class="switch"><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''}> Destaque na loja</label></div>
    </div>`,
    onSubmit: async d => {
      if (d.price === '') throw new Error('Informe o preço');
      const body = { ...d, price_cents: Math.round(Number(d.price) * 100), compare_cents: d.compare ? Math.round(Number(d.compare) * 100) : null, stock: d.stock === '' ? null : d.stock };
      p.id ? await api('PUT', '/api/admin/products/' + p.id, body) : await api('POST', '/api/admin/products', body);
      toast(p.id ? 'Produto atualizado' : 'Produto criado', 'ok'); route();
    },
  });
}

// ---------------------------------------------------------------- Pedidos
PAGES.pedidos = async (page) => {
  const f = state.orders;
  const qs = new URLSearchParams({ status: f.status, game: f.game, channel: f.channel, q: f.q, page: f.page, size: 25 });
  const d = await api('GET', '/api/admin/orders?' + qs);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  page.innerHTML = pageHead('08 · CLIENTES', 'Pedidos', 'Todas as compras — feitas no site ou dentro dos jogos.',
    `<a class="btn" href="/api/admin/export/orders.csv?${new URLSearchParams({ status: f.status, game: f.game, channel: f.channel, q: f.q })}">${icon('download', 15)}CSV</a><button class="btn primary" id="newOrder">${icon('plus', 16)}Venda manual</button>`) + `
    <div class="filters">
      <div class="seg" id="oStatus"><button data-v="" class="${!f.status ? 'on' : ''}">Todos</button>${['pending', 'paid', 'delivered', 'refunded', 'canceled', 'expired'].map(k => `<button data-v="${k}" class="${f.status === k ? 'on' : ''}"><span class="status ${k}"></span>${{ pending: 'Aguardando', paid: 'A entregar', delivered: 'Entregues', refunded: 'Estornados', canceled: 'Cancelados', expired: 'Expirados' }[k]}</button>`).join('')}</div>
      <select class="select" id="oGame">${gameOptions(f.game)}</select>
      <select class="select" id="oChannel" style="min-width:140px"><option value="">Todos os canais</option>${Object.entries(L.channel).map(([k, v]) => `<option value="${k}" ${f.channel === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <div class="input-group">${icon('search', 15)}<input class="input" id="oQ" placeholder="Código, jogador ou ID no jogo" value="${esc(f.q)}"></div>
    </div>
    <section class="panel"><div class="panel-b flush"><div class="table-wrap">
      ${d.rows.length ? `<table class="table"><thead><tr><th>Pedido</th><th>Data</th><th>Jogo</th><th>Jogador</th><th>Canal</th><th>Pagamento</th><th>Verificação</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map(o => `<tr class="row-link" data-code="${esc(o.code)}">
          <td class="code">${esc(o.code)}</td><td class="t2 mono" style="font-size:12px">${F.dt(o.created_at)}</td>
          <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="viz-key rect" style="background:${gameColor(o.game_id)}"></span>${esc(o.game_name)}</span></td>
          <td>${esc(o.username || o.customer_name || '—')}${o.external_player_id ? `<small class="muted mono" style="display:block;font-size:11px">ID ${esc(o.external_player_id)}</small>` : ''}</td>
          <td class="t2">${L.channel[o.channel]}<small class="muted" style="display:block;font-size:11px">${L.plat[o.platform] || o.platform}</small></td>
          <td class="t2">${L.pay[o.payment_method] || o.payment_method}${o.payer_name ? `<small class="muted" style="display:block;font-size:11px">${esc(o.payer_name)}</small>` : ''}</td>
          <td>${vbadge(o)}</td>
          <td class="r"><b style="font-weight:600">${F.money(o.total_cents)}</b></td>
          <td><span class="status ${o.status}">${L.status[o.status]}</span></td></tr>`).join('')}
      </tbody></table>` : emptyBox('receipt', 'Nenhum pedido', 'Nenhum pedido encontrado com esses filtros.')}
    </div></div>
    <div class="panel-f"><span>${F.int(d.total)} pedido(s)</span><div class="pager">
      <button class="btn sm icon" id="pPrev" ${f.page <= 1 ? 'disabled' : ''} aria-label="Anterior">${icon('chevronLeft', 15)}</button>
      <span class="mono">${f.page} / ${pages}</span>
      <button class="btn sm icon" id="pNext" ${f.page >= pages ? 'disabled' : ''} aria-label="Próxima">${icon('chevronRight', 15)}</button></div></div></section>`;
  const re = () => PAGES.pedidos(page);
  $$('#oStatus button').forEach(b => b.onclick = () => { f.status = b.dataset.v; f.page = 1; re(); });
  $('#oGame').onchange = e => { f.game = e.target.value; f.page = 1; re(); };
  $('#oChannel').onchange = e => { f.channel = e.target.value; f.page = 1; re(); };
  $('#oQ').oninput = e => { f.q = e.target.value; f.page = 1; clearTimeout(re.t); re.t = setTimeout(async () => { await re(); const i = $('#oQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
  $('#pPrev').onclick = () => { f.page--; re(); };
  $('#pNext').onclick = () => { f.page++; re(); };
  $$('[data-code]', page).forEach(tr => tr.onclick = () => orderDrawer(tr.dataset.code));
  $('#newOrder').onclick = manualOrder;
};
async function orderDrawer(code) {
  const o = await api('GET', '/api/admin/orders/' + encodeURIComponent(code));
  const held = o.review && ['pending', 'paid'].includes(o.status);
  const acts = [];
  if (o.provider === 'mercadopago' && ['pending', 'paid'].includes(o.status)) acts.push(['verify', 'Consultar no banco', '']);
  if (o.status === 'pending' && o.provider !== 'mercadopago') acts.push(['confirm', 'Confirmar pagamento', 'primary']);
  if (o.status === 'pending') acts.push(['cancel', 'Cancelar', 'danger']);
  if (held && o.status === 'paid') acts.push(['approve', 'Liberar após análise', 'primary']);
  if (o.status === 'paid' && !held) acts.push(['deliver', 'Marcar como entregue', '']);
  if (['paid', 'delivered'].includes(o.status)) acts.push(['refund', 'Estornar', 'danger']);
  const pst = o.player_stats;
  const dr = drawer(`
    <div class="dialog-h"><div><span class="label">Pedido</span><h3 class="mono" style="margin-top:4px">${esc(o.code)}</h3></div><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="flex:1">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap"><b style="font-size:26px;font-weight:600">${F.money(o.total_cents)}</b><span class="status ${o.status}">${L.status[o.status]}</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${vbadge(o)}${riskBar(o.risk_score)}</div>
      ${held ? `<div class="banner" style="margin-top:14px;border-color:rgba(208,59,59,.5);background:rgba(208,59,59,.08);color:#ffb0b0">${icon('alert', 18)}<span><b>Retido para análise.</b> O jogo não recebe este pedido até você liberar.</span></div>` : ''}
      ${o.risk_flags.length ? `<div class="section-t"><span class="label">Sinais de risco</span></div><ul class="flags">${o.risk_flags.map(f => `<li><span class="mono">+${f.points}</span>${esc(f.text)}</li>`).join('')}</ul>` : ''}
      <div class="section-t"><span class="label">Comprador</span></div>
      <dl class="kv">
        <dt>Conta</dt><dd>${o.player_id ? `<a href="#" data-player="${o.player_id}" style="color:var(--accent)">${esc(o.username || '—')}</a>` : esc(o.customer_name || '—')}${o.email ? `<span class="muted"> · ${esc(o.email)}</span>` : ''}</dd>
        ${pst ? `<dt>Histórico</dt><dd>${F.int(pst.orders)} pedidos · ${F.money(pst.spent)} gastos${pst.refunds ? ` · <span style="color:#f07a7a">${pst.refunds} estorno(s)</span>` : ''}</dd>` : ''}
        <dt>ID no jogo</dt><dd class="mono">${esc(o.external_player_id || '—')}</dd>
        <dt>Jogo · canal</dt><dd>${esc(o.game_name)} · ${L.channel[o.channel]} · ${L.plat[o.platform] || esc(o.platform)}</dd>
        <dt>IP do pedido</dt><dd class="mono">${esc(o.ip || '—')}</dd>
      </dl>
      <div class="section-t"><span class="label">Pagamento</span></div>
      <dl class="kv">
        <dt>Método</dt><dd>${L.pay[o.payment_method] || esc(o.payment_method)} · ${L.provider[o.provider] || esc(o.provider || '—')}</dd>
        <dt>Valor esperado</dt><dd>${F.money(o.total_cents)}</dd>
        <dt>Valor recebido</dt><dd>${o.paid_amount_cents == null ? '<span class="muted">—</span>' : o.paid_amount_cents === o.total_cents ? `${F.money(o.paid_amount_cents)} <span class="vbadge provider">${icon('check', 11)}confere</span>` : `<b style="color:#f07a7a">${F.money(o.paid_amount_cents)} — divergente</b>`}</dd>
        ${o.net_amount_cents != null ? `<dt>Líquido (após taxas)</dt><dd>${F.money(o.net_amount_cents)}</dd>` : ''}
        <dt>Pagador</dt><dd>${esc(o.payer_name || '—')}${o.payer_doc ? ` <span class="mono muted">${esc(o.payer_doc)}</span>` : ''}${o.payer_email ? `<span class="muted"> · ${esc(o.payer_email)}</span>` : ''}</dd>
        ${o.provider_payment_id ? `<dt>ID no provedor</dt><dd class="mono">${esc(o.provider_payment_id)} <span class="muted">(${esc(o.provider_status || '')})</span></dd>` : ''}
        ${o.e2e_id ? `<dt>Pix E2E</dt><dd class="mono">${esc(o.e2e_id)}</dd>` : ''}
        ${o.external_ref ? `<dt>Recibo da loja</dt><dd class="mono">${esc(o.external_ref)}</dd>` : ''}
        ${o.verified_at ? `<dt>Verificado em</dt><dd>${F.dt(o.verified_at)}${o.verified_by_name ? ' por ' + esc(o.verified_by_name) : ''}</dd>` : ''}
      </dl>
      <div class="section-t"><span class="label">Itens</span></div>
      <table class="table"><tbody>${o.items.map(i => `<tr><td style="padding-left:0"><div class="cell-main"><span class="pi ${i.type}">${icon(L.typeIcon[i.type], 16)}</span><div><b>${i.qty}× ${esc(i.name)}</b><small>${esc(i.sku)}${i.coins ? ' · ' + F.int(i.coins * i.qty) + ' moedas' : ''}</small></div></div></td><td class="r" style="padding-right:0">${F.money(i.unit_cents * i.qty)}</td></tr>`).join('')}</tbody></table>
      <div class="section-t"><span class="label">Histórico do pedido</span></div>
      <ul class="evlog">${o.events.map(e => `<li class="${e.kind}"><span class="dot"></span><div><b>${esc(e.message)}</b><small>${F.dt(e.at)} · ${esc(e.actor || 'sistema')}</small></div></li>`).join('') || '<li><div class="muted">Sem eventos.</div></li>'}</ul>
    </div>
    <div class="dialog-f">${acts.map(([k, l, c]) => `<button class="btn ${c}" data-act="${k}">${l}</button>`).join('') || '<span class="muted" style="font-size:12px">Pedido finalizado.</span>'}</div>`);
  const pl = $('[data-player]', dr); if (pl) pl.onclick = e => { e.preventDefault(); playerDrawer(Number(pl.dataset.player)); };
  const after = msg => { toast(msg, 'ok'); closeLayer(); route(); };
  const url = a => `/api/admin/orders/${encodeURIComponent(code)}/${a}`;
  $$('[data-act]', dr).forEach(b => b.onclick = async () => {
    const a = b.dataset.act;
    try {
      if (a === 'verify') { b.disabled = true; const r = await api('POST', url('verify')); toast(`Banco: ${r.provider_status || 'sem pagamento'} → pedido ${L.status[r.status]}${r.review ? ' (retido)' : ''}`, r.status === 'paid' ? 'ok' : ''); return orderDrawer(code); }
      if (a === 'cancel') { if (await confirmDialog('Cancelar pedido', `Cancelar ${o.code}? O estoque é devolvido.`, 'Cancelar pedido')) { await api('POST', url('cancel')); after('Pedido cancelado'); } else orderDrawer(code); return; }
      if (a === 'deliver') { await api('POST', url('deliver')); return after('Entrega registrada'); }
      if (a === 'confirm') return stepUpDialog({ title: 'Confirmar pagamento recebido', action: 'Confirmar pagamento',
        text: `Abra o extrato do banco e localize o Pix de ${F.money(o.total_cents)}. Copie do comprovante o ID da transação (E2E) — o sistema bloqueia comprovantes já usados e valores diferentes.`,
        fields: `<label class="field"><span>ID da transação Pix (E2E) *</span><input class="input mono" name="e2e_id" required maxlength="32" placeholder="E00000000202611031200XXXXXXXXXXX"></label>
          <div class="form-grid"><label class="field"><span>Valor recebido (R$) *</span><input class="input" name="amount" required inputmode="decimal" placeholder="${(o.total_cents / 100).toFixed(2).replace('.', ',')}"></label>
          <label class="field"><span>Nome do pagador</span><input class="input" name="payer_name" maxlength="80"></label></div>`,
        run: async (ex, d) => { await api('POST', url('confirm'), { ...ex, e2e_id: d.e2e_id, amount: d.amount, payer_name: d.payer_name }); after('Pagamento confirmado'); } });
      if (a === 'approve') return stepUpDialog({ title: 'Liberar pedido retido', action: 'Liberar para entrega', text: 'Confirme que analisou os sinais de risco e que o pagamento é legítimo. A liberação fica registrada na auditoria.',
        fields: '<label class="field"><span>Motivo / observação</span><input class="input" name="note" maxlength="200"></label>',
        run: async (ex, d) => { await api('POST', url('approve'), { ...ex, note: d.note }); after('Pedido liberado'); } });
      if (a === 'refund') return stepUpDialog({ title: 'Estornar pedido', danger: true, action: 'Estornar',
        text: o.provider === 'mercadopago' ? `O valor de ${F.money(o.total_cents)} será devolvido ao pagador pelo Mercado Pago e o estoque restaurado.` : `O pedido será marcado como estornado. Devolva ${F.money(o.total_cents)} ao pagador manualmente.`,
        run: async ex => { await api('POST', url('refund'), ex); after('Pedido estornado'); } });
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  });
}
const vbadge = o => o.review && ['pending', 'paid'].includes(o.status) ? `<span class="vbadge review">${icon('alert', 11)}Em análise</span>`
  : `<span class="vbadge ${o.verification || 'none'}">${icon(L.verifIcon[o.verification] || 'alert', 11)}${L.verif[o.verification] || L.verif.none}</span>`;
const riskBar = score => { const c = score >= 60 ? 'var(--critical)' : score >= 30 ? 'var(--warning)' : 'var(--good)'; return `<span class="risk" title="Pontuação de risco antifraude">${icon('shield', 12)}<i><b style="width:${Math.max(4, score)}%;background:${c}"></b></i>${score}</span>`; };

async function manualOrder() {
  const prods = (await api('GET', '/api/admin/products')).filter(p => p.active);
  if (!prods.length) return toast('Cadastre produtos primeiro', 'err');
  dialog({
    title: 'Registrar venda manual', submit: 'Registrar',
    body: `<div class="form-grid">
      <label class="field full"><span>Produto</span><select class="select" name="product_id">${prods.map(p => `<option value="${p.id}" data-game="${p.game_id}">${esc(p.game_name)} — ${esc(p.name)} · ${F.money(p.price_cents)}</option>`).join('')}</select></label>
      <label class="field"><span>Quantidade</span><input class="input" type="number" name="qty" min="1" value="1"></label>
      <label class="field"><span>Status</span><select class="select" name="status"><option value="paid">Pago · a entregar</option><option value="delivered">Entregue</option><option value="pending">Aguardando pagamento</option></select></label>
      <label class="field"><span>Cliente</span><input class="input" name="customer_name"></label>
      <label class="field"><span>ID do jogador no jogo</span><input class="input mono" name="external_player_id"></label>
      <label class="field"><span>Pagamento</span><select class="select" name="payment_method">${Object.entries(L.pay).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="field"><span>Observação</span><input class="input" name="note"></label>
    </div>`,
    onSubmit: d => {
      const p = prods.find(x => x.id === Number(d.product_id));
      stepUpDialog({ title: 'Confirmar venda manual', text: `Registrar ${d.qty}× ${p.name} como ${d.status === 'pending' ? 'aguardando pagamento' : 'paga'}. Vendas manuais ficam registradas na auditoria com seu nome.`, action: 'Registrar',
        run: async ex => { const o = await api('POST', '/api/admin/orders', { ...d, ...ex, game_id: p.game_id, items: [{ product_id: p.id, qty: d.qty }] }); toast('Venda registrada: ' + o.code, 'ok'); route(); } });
      return false;
    },
  });
}

// ---------------------------------------------------------------- Jogadores
async function playerDrawer(id) {
  const p = await api('GET', '/api/admin/players/' + id);
  const t = p.totals;
  const dr = drawer(`
    <div class="dialog-h"><div><span class="label">Jogador</span><h3 style="margin-top:4px">${esc(p.username)}</h3></div><button class="btn ghost icon sm x" data-x>${icon('close', 16)}</button></div>
    <div class="dialog-b" style="flex:1">
      <div class="mini-kpis">
        <div><span class="label">Total gasto</span><b>${F.money(t.spent)}</b></div>
        <div><span class="label">Compras pagas</span><b>${F.int(t.paid_orders)}</b></div>
        <div><span class="label">Moedas</span><b>${F.int(t.coins)}</b></div>
        <div><span class="label">Ticket médio</span><b>${F.money(t.paid_orders ? t.spent / t.paid_orders : 0)}</b></div>
      </div>
      ${t.refunded || p.same_ip_accounts >= 2 || p.blocked ? `<div class="banner" style="margin-top:14px">${icon('alert', 18)}<span>${[p.blocked ? 'Conta bloqueada' : '', t.refunded ? `${F.money(t.refunded)} em estornos` : '', p.same_ip_accounts >= 2 ? `${p.same_ip_accounts} outras contas criadas do mesmo IP` : ''].filter(Boolean).join(' · ')}</span></div>` : ''}
      <div class="section-t"><span class="label">Dados</span></div>
      <dl class="kv"><dt>E-mail</dt><dd>${esc(p.email || '—')}</dd><dt>Origem</dt><dd>${p.origin === 'site' ? 'Site' : 'Jogo'}${p.origin_game ? ' · ' + esc(p.origin_game) : ''}</dd>
        <dt>Cadastro</dt><dd>${F.dt(p.created_at)}</dd><dt>Primeira compra</dt><dd>${F.dt(t.first_purchase)}</dd><dt>Última compra</dt><dd>${F.dt(t.last_purchase)}</dd>
        <dt>IDs no jogo</dt><dd>${p.links.map(l => `<span class="tag" style="margin:0 4px 4px 0">${esc(l.game)} · ${esc(l.external_id)}</span>`).join('') || '—'}</dd>
        <dt>IP (cadastro / último)</dt><dd class="mono">${esc(p.signup_ip || '—')} / ${esc(p.last_ip || '—')}</dd></dl>
      ${p.by_game.length ? `<div class="section-t"><span class="label">Gasto por jogo</span></div><table class="table"><tbody>${p.by_game.map(g => `<tr><td style="padding-left:0">${esc(g.game)}</td><td class="r t2">${F.int(g.orders)} compras</td><td class="r t2">${F.int(g.coins)} ${esc(g.currency_name).toLowerCase()}</td><td class="r" style="padding-right:0"><b>${F.money(g.spent)}</b></td></tr>`).join('')}</tbody></table>` : ''}
      <div class="section-t"><span class="label">Pedidos</span></div>
      <table class="table"><tbody>${p.orders.map(o => `<tr class="row-link" data-code="${esc(o.code)}"><td style="padding-left:0;white-space:nowrap" class="code">${esc(o.code)}<small class="muted" style="display:block;font-family:var(--font)">${F.dt(o.created_at)} · ${esc(o.game)}</small></td><td><span class="status ${o.status}">${L.status[o.status]}</span></td><td>${vbadge(o)}</td><td class="r" style="padding-right:0"><b>${F.money(o.total_cents)}</b></td></tr>`).join('') || '<tr><td class="muted">Nenhum pedido.</td></tr>'}</tbody></table>
    </div>
    <div class="dialog-f"><button class="btn ${p.blocked ? '' : 'danger'}" id="blk">${icon(p.blocked ? 'check' : 'lock', 15)}${p.blocked ? 'Desbloquear conta' : 'Bloquear conta'}</button></div>`);
  $$('[data-code]', dr).forEach(tr => tr.onclick = () => orderDrawer(tr.dataset.code));
  $('#blk').onclick = async () => {
    if (!p.blocked && !(await confirmDialog('Bloquear conta', `${p.username} não poderá entrar nem comprar. As sessões abertas são encerradas.`, 'Bloquear'))) return playerDrawer(id);
    await api('POST', `/api/admin/players/${id}/block`, { block: !p.blocked }); toast(p.blocked ? 'Conta desbloqueada' : 'Conta bloqueada', 'ok'); playerDrawer(id);
  };
}
PAGES.jogadores = async (page) => {
  const f = state.players;
  const d = await api('GET', '/api/admin/players?' + new URLSearchParams({ q: f.q, page: f.page, sort: f.sort, size: 25 }));
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  page.innerHTML = pageHead('09 · CLIENTES', 'Jogadores', 'Contas criadas no site e jogadores registrados pelos jogos.') + `
    <div class="filters">
      <div class="input-group">${icon('search', 15)}<input class="input" id="jQ" placeholder="Usuário, e-mail ou ID no jogo" value="${esc(f.q)}"></div>
      <div class="seg" id="jSort"><button data-v="" class="${!f.sort ? 'on' : ''}">Mais recentes</button><button data-v="spent" class="${f.sort === 'spent' ? 'on' : ''}">Maiores compradores</button></div>
    </div>
    <section class="panel"><div class="panel-b flush"><div class="table-wrap">
      ${d.rows.length ? `<table class="table"><thead><tr><th>Jogador</th><th>Origem</th><th>País</th><th>Cadastro</th><th>Última compra</th><th class="r">Compras</th><th class="r">Moedas</th><th class="r">Total gasto</th></tr></thead><tbody>
      ${d.rows.map(p => `<tr class="row-link" data-pid="${p.id}"><td><div class="cell-main"><span class="pi">${icon('user', 15)}</span><div><b>${esc(p.username)}${p.blocked ? ' <span class="vbadge review">bloqueado</span>' : ''}</b><small>${esc(p.email || 'sem e-mail')}</small></div></div></td>
        <td class="t2">${p.origin === 'site' ? 'Site' : 'Jogo'}${p.origin_game ? `<small class="muted" style="display:block;font-size:11px">${esc(p.origin_game)}</small>` : ''}</td>
        <td class="mono t2">${esc(p.country || '—')}</td><td class="mono t2" style="font-size:12px">${F.dt(p.created_at)}</td>
        <td class="t2">${p.last_purchase ? 'há ' + F.ago(p.last_purchase) : '—'}</td><td class="r">${F.int(p.orders)}</td><td class="r">${p.coins ? F.int(p.coins) : '<span class="muted">—</span>'}</td><td class="r"><b style="font-weight:600">${F.money(p.spent)}</b></td></tr>`).join('')}
      </tbody></table>` : emptyBox('players', 'Nenhum jogador', 'Jogadores aparecem aqui quando se cadastram no site ou quando o jogo os registra pela API.')}
    </div></div>
    <div class="panel-f"><span>${F.int(d.total)} jogador(es)</span><div class="pager">
      <button class="btn sm icon" id="jPrev" ${f.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft', 15)}</button><span class="mono">${f.page} / ${pages}</span>
      <button class="btn sm icon" id="jNext" ${f.page >= pages ? 'disabled' : ''}>${icon('chevronRight', 15)}</button></div></div></section>`;
  const re = () => PAGES.jogadores(page);
  $('#jQ').oninput = e => { f.q = e.target.value; f.page = 1; clearTimeout(re.t); re.t = setTimeout(async () => { await re(); const i = $('#jQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
  $$('#jSort button').forEach(b => b.onclick = () => { f.sort = b.dataset.v; f.page = 1; re(); });
  $$('[data-pid]', page).forEach(tr => tr.onclick = () => playerDrawer(Number(tr.dataset.pid)));
  $('#jPrev').onclick = () => { f.page--; re(); };
  $('#jNext').onclick = () => { f.page++; re(); };
};

// ---------------------------------------------------------------- Integração
function snippets(g, base) {
  const key = g.api_key;
  const sku = 'CR_1200';
  return {
    curl: `<span class="c"># 1. Registrar/identificar o jogador (chame ao fazer login no jogo)</span>
curl -X POST ${base}/api/v1/players \\
  -H <span class="s">"Authorization: Bearer ${key}"</span> -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"external_id":"PLAYER_123","username":"kaze","platform":"android"}'</span>

<span class="c"># 2. Telemetria: sessão iniciada, instalação…</span>
curl -X POST ${base}/api/v1/events -H <span class="s">"Authorization: Bearer ${key}"</span> -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"type":"session_start","external_id":"PLAYER_123","platform":"android"}'</span>

<span class="c"># 3. Compra feita dentro do jogo (Google Play / App Store / Steam já cobrou → status "paid")</span>
curl -X POST ${base}/api/v1/purchases -H <span class="s">"Authorization: Bearer ${key}"</span> -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"external_id":"PLAYER_123","items":[{"sku":"${sku}","qty":1}],"platform":"android","payment_method":"google_play","external_ref":"GPA.1234-5678","status":"paid"}'</span>

<span class="c"># 4. Entregas pendentes (compras feitas no site) — consulte ao abrir o jogo</span>
curl ${base}/api/v1/deliveries?external_id=PLAYER_123 -H <span class="s">"Authorization: Bearer ${key}"</span>

<span class="c"># 5. Confirmar que o jogo creditou os itens</span>
curl -X POST ${base}/api/v1/deliveries/NX-XXXX-XXXX/ack -H <span class="s">"Authorization: Bearer ${key}"</span>`,
    unity: `<span class="c">// Copie sdk/unity/NexusClient.cs para Assets/Scripts e configure no Inspector.</span>
<span class="k">var</span> nexus = GetComponent&lt;NexusClient&gt;();
nexus.baseUrl = <span class="s">"${base}"</span>;
nexus.apiKey  = <span class="s">"${key}"</span>;

<span class="c">// ao logar</span>
StartCoroutine(nexus.RegisterPlayer(playerId, playerName));
StartCoroutine(nexus.TrackEvent(<span class="s">"session_start"</span>, playerId));

<span class="c">// após a loja da plataforma confirmar o pagamento</span>
StartCoroutine(nexus.ReportPurchase(playerId, <span class="s">"${sku}"</span>, <span class="n">1</span>, <span class="s">"google_play"</span>, receiptId));

<span class="c">// entregar compras feitas no site</span>
StartCoroutine(nexus.ClaimDeliveries(playerId, order =&gt; {
    <span class="k">foreach</span> (<span class="k">var</span> item <span class="k">in</span> order.items) Wallet.Add(item.coins * item.qty);
}));`,
    godot: `<span class="c"># Copie sdk/godot/nexus.gd e adicione como Autoload "Nexus".</span>
Nexus.base_url = <span class="s">"${base}"</span>
Nexus.api_key = <span class="s">"${key}"</span>

Nexus.register_player(player_id, player_name)
Nexus.track(<span class="s">"session_start"</span>, player_id)
Nexus.report_purchase(player_id, <span class="s">"${sku}"</span>, <span class="n">1</span>, <span class="s">"pix"</span>, <span class="s">"paid"</span>)

<span class="k">var</span> pendentes = <span class="k">await</span> Nexus.claim_deliveries(player_id)
<span class="k">for</span> order <span class="k">in</span> pendentes:
    <span class="k">for</span> item <span class="k">in</span> order.items:
        Wallet.add(item.coins * item.qty)
    Nexus.ack_delivery(order.code)  <span class="c"># confirma só depois de creditar</span>`,
    js: `<span class="k">const</span> nexus = (path, body) =&gt; fetch(<span class="s">\`${base}/api/v1\${path}\`</span>, {
  method: body ? <span class="s">'POST'</span> : <span class="s">'GET'</span>,
  headers: { Authorization: <span class="s">'Bearer ${key}'</span>, <span class="s">'Content-Type'</span>: <span class="s">'application/json'</span> },
  body: body &amp;&amp; JSON.stringify(body),
}).then(r =&gt; r.json());

<span class="k">await</span> nexus(<span class="s">'/players'</span>, { external_id: <span class="s">'PLAYER_123'</span>, username: <span class="s">'kaze'</span> });
<span class="k">await</span> nexus(<span class="s">'/events'</span>, { type: <span class="s">'session_start'</span>, external_id: <span class="s">'PLAYER_123'</span> });
<span class="k">const</span> { products } = <span class="k">await</span> nexus(<span class="s">'/catalog'</span>);
<span class="k">await</span> nexus(<span class="s">'/purchases'</span>, { external_id: <span class="s">'PLAYER_123'</span>, items: [{ sku: <span class="s">'${sku}'</span>, qty: <span class="n">1</span> }], status: <span class="s">'paid'</span>, payment_method: <span class="s">'steam'</span> });`,
  };
}
PAGES.integracao = async (page) => {
  await loadGames();
  if (!state.games.length) { page.innerHTML = pageHead('10 · SISTEMA', 'Integração · API', '') + `<section class="panel">${emptyBox('plug', 'Cadastre um jogo', 'Cada jogo recebe uma chave de API própria.', '<a class="btn primary" href="#/jogos">Ir para Jogos</a>')}</section>`; return; }
  const g = state.games.find(x => String(x.id) === String(state.intGame)) || state.games[0];
  state.intGame = g.id;
  const base = location.origin;
  const sn = snippets(g, base);
  const tab = state.intTab || 'curl';
  const prods = (await api('GET', '/api/admin/products?game=' + g.id)).filter(p => p.active);
  page.innerHTML = pageHead('10 · SISTEMA', 'Integração · API', 'Conecte seus jogos: compras feitas no jogo entram no painel, e compras feitas no site são entregues no jogo.') + `
    <div class="filters"><span class="t2" style="display:flex">${icon('gamepad', 16)}</span><select class="select" id="iGame">${gameOptions(g.id, '')}</select><span class="range-text">API v1 · JSON · HTTPS</span></div>
    <div class="grid">
      ${panel('s6', '01', 'Credenciais', esc(g.name), '', `
        <label class="field"><span>Chave de API (secreta — use só no jogo/servidor)</span>
          <div class="keybox"><code id="apiKey" data-key="${esc(g.api_key)}">${esc(g.api_key.slice(0, 12))}${'•'.repeat(20)}</code>
            <button class="btn sm ghost icon" id="kShow" title="Mostrar">${icon('eye', 15)}</button><button class="btn sm ghost icon" id="kCopy" title="Copiar">${icon('copy', 15)}</button><button class="btn sm ghost icon" id="kRot" title="Gerar nova chave">${icon('refresh', 15)}</button></div></label>
        <label class="field" style="margin-top:14px"><span>URL base</span><div class="keybox"><code>${esc(base)}/api/v1</code><button class="btn sm ghost icon" id="bCopy">${icon('copy', 15)}</button></div></label>
        <div class="section-t"><span class="label">Assinatura HMAC (anti-fraude)</span></div>
        <p class="t2" style="font-size:12.5px;margin-bottom:10px">Com a assinatura, cada requisição leva <code>X-Nexus-Timestamp</code> e <code>X-Nexus-Signature = HMAC-SHA256(segredo, "ts.MÉTODO.caminho.corpo")</code>. Requisições forjadas ou repetidas são recusadas e as compras ficam marcadas como <b style="color:var(--text)">assinadas</b>.</p>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn sm" id="sigGen">${icon('key', 14)}${g.has_signing_secret ? 'Gerar novo segredo' : 'Criar segredo'}</button>
          <label class="switch"><input type="checkbox" id="sigReq" ${g.require_signature ? 'checked' : ''} ${g.has_signing_secret ? '' : 'disabled'}> Exigir assinatura</label>
          <span class="vbadge ${g.require_signature ? 'provider' : 'game_reported'}">${g.require_signature ? 'Obrigatória' : 'Opcional'}</span></div>
        <div class="section-t"><span class="label">Como funciona</span></div>
        <ol class="t2" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:13px">
          <li><b style="color:var(--text)">Compra no jogo:</b> a loja da plataforma (Google Play, App Store, Steam) cobra o jogador e o jogo chama <code>POST /purchases</code> com <code>status: "paid"</code>. A venda aparece aqui na hora.</li>
          <li><b style="color:var(--text)">Compra no site:</b> o jogador paga via Pix na página do jogo informando o ID dele. Quando o pagamento é confirmado, o jogo busca em <code>GET /deliveries</code>, credita as moedas e confirma com <code>/ack</code>.</li>
          <li><b style="color:var(--text)">Telemetria:</b> o jogo envia <code>session_start</code>, <code>install</code> etc. para alimentar os gráficos de audiência.</li>
        </ol>`)}
      ${panel('s6', '02', 'Endpoints', '', '', `<table class="endpoints"><tbody>
        ${[['get', '/catalog', 'Produtos ativos do jogo (preço, SKU, moedas)'], ['post', '/players', 'Registra/identifica jogador pelo seu ID interno'], ['post', '/events', 'Telemetria: session_start, install, download (ou lote em "events")'],
          ['post', '/purchases', 'Registra compra (paid = já cobrada; pending = gera Pix)'], ['get', '/purchases/:code', 'Consulta um pedido'], ['get', '/deliveries?external_id=', 'Compras pagas aguardando entrega para o jogador'], ['post', '/deliveries/:code/ack', 'Confirma que os itens foram creditados']]
          .map(([m, p, d]) => `<tr><td><span class="method ${m}">${m.toUpperCase()}</span></td><td>${p}</td><td>${d}</td></tr>`).join('')}
        </tbody></table><p class="muted" style="font-size:12px;margin-top:12px">Autenticação: cabeçalho <code>Authorization: Bearer &lt;chave&gt;</code>. Compras com o mesmo <code>external_ref</code> não são duplicadas.</p>`)}
      ${panel('s7', '03', 'Exemplos de código', '', `<div class="seg" id="iTab">${[['curl', 'cURL'], ['unity', 'Unity C#'], ['godot', 'Godot'], ['js', 'JavaScript']].map(([k, l]) => `<button data-v="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`, `<pre class="code" id="code">${sn[tab]}</pre>`)}
      ${panel('s5', '04', 'Console de teste', 'simula o jogo chamando a API', '', `
        <form id="tForm" class="form-grid">
          <label class="field full"><span>Ação</span><select class="select" name="action"><option value="purchase">Compra no jogo (paga)</option><option value="session">Sessão iniciada</option><option value="player">Registrar jogador</option><option value="deliveries">Consultar entregas pendentes</option></select></label>
          <label class="field"><span>ID do jogador</span><input class="input mono" name="ext" value="TEST_${Math.floor(Math.random() * 900 + 100)}"></label>
          <label class="field"><span>Produto</span><select class="select" name="sku">${prods.map(p => `<option value="${esc(p.sku)}">${esc(p.name)}</option>`).join('')}</select></label>
          <div class="full"><button class="btn primary" type="submit">${icon('send', 15)}Enviar requisição</button></div>
        </form>
        <div class="section-t"><span class="label">Resposta</span></div><pre class="code console-out" id="tOut"><span class="c">// a resposta da API aparece aqui</span></pre>`)}
    </div>`;
  $('#iGame').onchange = e => { state.intGame = e.target.value; PAGES.integracao(page); };
  $$('#iTab button').forEach(b => b.onclick = () => { state.intTab = b.dataset.v; $$('#iTab button').forEach(x => x.classList.toggle('on', x === b)); $('#code').innerHTML = sn[b.dataset.v]; });
  const k = $('#apiKey');
  $('#kShow').onclick = () => { k.textContent = k.textContent.includes('•') ? k.dataset.key : k.dataset.key.slice(0, 12) + '•'.repeat(20); };
  $('#kCopy').onclick = () => copy(k.dataset.key);
  $('#bCopy').onclick = () => copy(base + '/api/v1');
  $('#kRot').onclick = () => stepUpDialog({ title: 'Gerar nova chave', text: 'A chave atual para de funcionar imediatamente. Você vai precisar atualizar o jogo.', action: 'Gerar nova chave', danger: true,
    run: async ex => { await api('POST', `/api/admin/games/${g.id}/rotate-key`, ex); toast('Nova chave gerada', 'ok'); PAGES.integracao(page); } });
  $('#sigGen').onclick = () => stepUpDialog({ title: g.has_signing_secret ? 'Gerar novo segredo de assinatura' : 'Criar segredo de assinatura', text: 'O segredo é mostrado uma única vez. Guarde-o no servidor do jogo (nunca no cliente público, se puder evitar).', action: 'Gerar',
    run: async ex => { const r = await api('POST', `/api/admin/games/${g.id}/signing`, { ...ex, regenerate: true }); showSecretOnce('Segredo de assinatura', r.signing_secret); await loadGames(); } });
  $('#sigReq').onchange = e => { const want = e.target.checked; e.target.checked = !want;
    stepUpDialog({ title: want ? 'Exigir assinatura' : 'Desativar exigência de assinatura', text: want ? 'Requisições sem assinatura HMAC válida serão recusadas. Garanta que o jogo já envia a assinatura.' : 'Requisições sem assinatura voltarão a ser aceitas (compras ficam marcadas como "informado pelo jogo").', action: 'Confirmar', danger: !want,
      run: async ex => { await api('POST', `/api/admin/games/${g.id}/signing`, { ...ex, require: want }); toast('Configuração de assinatura atualizada', 'ok'); await loadGames(); PAGES.integracao(page); } }); };
  $('#tForm').onsubmit = async e => {
    e.preventDefault();
    const d = formData(e.target);
    const call = async (method, path, body) => {
      const r = await fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + g.api_key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, method, path, body: await r.json() };
    };
    let out;
    if (d.action === 'player') out = await call('POST', '/players', { external_id: d.ext, username: 'tester_' + d.ext.toLowerCase(), platform: 'pc' });
    if (d.action === 'session') { await call('POST', '/players', { external_id: d.ext, platform: 'pc' }); out = await call('POST', '/events', { type: 'session_start', external_id: d.ext, platform: 'pc' }); }
    if (d.action === 'purchase') { await call('POST', '/players', { external_id: d.ext, platform: 'pc' }); out = await call('POST', '/purchases', { external_id: d.ext, items: [{ sku: d.sku, qty: 1 }], platform: 'pc', payment_method: 'steam', status: 'paid', external_ref: 'TEST-' + Date.now() }); }
    if (d.action === 'deliveries') out = await call('GET', '/deliveries?external_id=' + encodeURIComponent(d.ext));
    $('#tOut').textContent = `${out.method} /api/v1${out.path}  →  HTTP ${out.status}\n\n${JSON.stringify(out.body, null, 2)}`;
  };
};

// ---------------------------------------------------------------- Configurações
PAGES.config = async (page) => {
  const [s, admins] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/admins')]);
  const mp = s.payment_provider === 'mercadopago';
  page.innerHTML = pageHead('12 · SISTEMA', 'Configurações', 'Loja, recebimento, verificação automática de pagamentos e administradores.') + `
    <div class="grid">
      ${panel('s6', '01', 'Recebimento e verificação', `ativo: <b style="color:var(--text)">${L.provider[s.provider_active]}</b>`, '', `<form id="sPay" class="form-grid">
        <div class="full seg" id="provSeg"><button type="button" data-v="mercadopago" class="${mp ? 'on' : ''}">${icon('shield', 14)}Mercado Pago (automático)</button><button type="button" data-v="manual_pix" class="${!mp ? 'on' : ''}">${icon('pix', 14)}Pix manual</button></div>
        <input type="hidden" name="payment_provider" value="${mp ? 'mercadopago' : 'manual_pix'}">
        <p class="full t2" style="font-size:12.5px" id="provHelp"></p>
        <div class="full mpOnly ${mp ? '' : 'hidden'}" style="display:grid;gap:14px">
          <label class="field"><span>Access Token de produção</span><input class="input mono" name="mp_access_token" autocomplete="off" placeholder="${s.mp_access_token_set ? 'configurado: ' + esc(s.mp_access_token_hint) + ' — deixe vazio para manter' : 'APP_USR-…'}"><small>Mercado Pago → Suas integrações → Credenciais de produção. Fica criptografado no servidor.</small></label>
          <label class="field"><span>Assinatura secreta do webhook</span><input class="input mono" name="mp_webhook_secret" autocomplete="off" placeholder="${s.mp_webhook_secret_set ? 'configurada: ' + esc(s.mp_webhook_secret_hint) : 'chave secreta das notificações'}"><small>Mercado Pago → Webhooks → evento "Pagamentos" → Assinatura secreta.</small></label>
          <label class="field"><span>URL pública do site</span><input class="input mono" name="public_url" value="${esc(s.public_url)}" placeholder="https://seusite.com.br"><small>Webhook a cadastrar: <code>${esc(s.webhook_url)}</code></small></label>
        </div>
        <div class="full manualOnly ${mp ? 'hidden' : ''}" style="display:grid;gap:14px">
          <label class="field"><span>Chave Pix</span><input class="input mono" name="pix_key" value="${esc(s.pix_key)}" placeholder="e-mail, CPF/CNPJ, telefone ou chave aleatória"></label>
          <div class="form-grid"><label class="field"><span>Nome do recebedor</span><input class="input" name="pix_name" value="${esc(s.pix_name)}" maxlength="25"></label>
          <label class="field"><span>Cidade</span><input class="input" name="pix_city" value="${esc(s.pix_city)}" maxlength="15"></label></div>
        </div>
        <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Salvar</button>${mp && s.mp_access_token_set ? '<button type="button" class="btn" id="testProv">Testar conexão</button>' : ''}</div></form>`)}
      ${panel('s6', '02', 'Administradores', 'quem pode abrir este painel', '', `
        <ul class="adm-list">${admins.map(a => `<li><span class="pi">${icon(a.owner ? 'key' : 'user', 15)}</span><div><b>${esc(a.email)}</b><small>${a.owner ? 'Dono (definido no servidor)' : 'Administrador'}${a.activated ? ` · ${a.totp_enabled ? '2FA ativo' : 'sem 2FA'}${a.last_login_at ? ' · último acesso ' + F.dt(a.last_login_at) : ''}` : ' · ainda não entrou'}</small></div>
          ${!a.owner && state.me.role === 'owner' ? `<button class="btn sm ghost icon danger" data-rm="${esc(a.email)}" title="Remover">${icon('trash', 15)}</button>` : ''}</li>`).join('')}</ul>
        ${state.me.role === 'owner' ? `<form id="addAdm" style="display:flex;gap:8px;margin-top:14px"><input class="input" name="email" type="email" placeholder="e-mail do novo administrador"><button class="btn">${icon('plus', 15)}Adicionar</button></form>
          <p class="muted" style="font-size:12px;margin-top:10px">A pessoa entra pelo site com esse e-mail (confirmado). Contas sem e-mail na lista veem só a loja.</p>`
        : '<p class="muted" style="font-size:12px;margin-top:10px">Somente o dono pode adicionar ou remover administradores.</p>'}`)}
      ${panel('s6', '03', 'Loja', '', '', `<form id="sStore" class="form-grid">
        <label class="field full"><span>Nome exibido no site</span><input class="input" name="store_name" value="${esc(s.store_name)}" placeholder="NEXUS Games"></label>
        <label class="field full"><span>E-mail de suporte</span><input class="input" name="support_email" value="${esc(s.support_email)}"></label>
        <div class="full"><button class="btn primary">Salvar</button></div></form>`)}
      ${panel('s6', '04', 'Dados', '', '', `
        <p class="t2" style="font-size:13px;margin-bottom:14px">Gere um conjunto de demonstração (3 jogos, milhares de jogadores, 120 dias de vendas e telemetria). <b style="color:var(--text)">Substitui jogos, jogadores, pedidos e eventos atuais.</b> Desativado em produção.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="demoBtn">${icon('database', 15)}Gerar dados de demonstração</button><a class="btn" href="/api/admin/export/orders.csv">${icon('download', 15)}Exportar pedidos (CSV)</a></div>`)}
    </div>`;
  const help = { mercadopago: 'Cada Pix é gerado pelo Mercado Pago. Quando o cliente paga, o servidor consulta o pagamento direto na API (com seu token), confere valor e pedido, e só então libera a entrega. Webhooks sem assinatura válida são recusados.', manual_pix: 'Pix estático com a sua chave. Não há confirmação automática: você confere o extrato e confirma cada pedido informando o ID E2E do comprovante.' };
  const setProv = v => { $('[name=payment_provider]').value = v; $$('#provSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); $$('.mpOnly').forEach(e => e.classList.toggle('hidden', v !== 'mercadopago')); $$('.manualOnly').forEach(e => e.classList.toggle('hidden', v === 'mercadopago')); $('#provHelp').textContent = help[v]; };
  setProv(mp ? 'mercadopago' : 'manual_pix');
  $$('#provSeg button').forEach(b => b.onclick = () => setProv(b.dataset.v));
  $('#sPay').onsubmit = e => { e.preventDefault(); const d = formData(e.target);
    for (const k of ['mp_access_token', 'mp_webhook_secret']) if (!d[k]) delete d[k];
    stepUpDialog({ title: 'Alterar recebimento', text: 'Alterações de pagamento exigem confirmação e ficam registradas na auditoria.', action: 'Salvar alterações',
      run: async ex => { const r = await api('PUT', '/api/admin/settings', { ...d, ...ex }); toast(r.changed.length ? 'Configurações de pagamento salvas' : 'Nada mudou', 'ok'); route(); } }); };
  const tp = $('#testProv'); if (tp) tp.onclick = async () => { try { const r = await api('POST', '/api/admin/settings/test-provider'); toast(`Conectado à conta ${r.account}${r.live ? '' : ' (modo TESTE)'}`, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $('#sStore').onsubmit = async e => { e.preventDefault(); try { await api('PUT', '/api/admin/settings', formData(e.target)); toast('Configurações salvas', 'ok'); } catch (err) { toast(err.message, 'err'); } };
  const add = $('#addAdm'); if (add) add.onsubmit = e => { e.preventDefault(); const email = formData(e.target).email; if (!email) return;
    stepUpDialog({ title: 'Adicionar administrador', text: `${email} terá acesso total ao painel (vendas, pagamentos, jogadores).`, action: 'Adicionar', run: async ex => { await api('POST', '/api/admin/admins', { ...ex, email }); toast('Administrador adicionado', 'ok'); route(); } }); };
  $$('[data-rm]').forEach(b => b.onclick = () => stepUpDialog({ title: 'Remover administrador', danger: true, text: `${b.dataset.rm} perde o acesso imediatamente (sessões encerradas).`, action: 'Remover',
    run: async ex => { await api('POST', '/api/admin/admins', { ...ex, email: b.dataset.rm, remove: true }); toast('Administrador removido', 'ok'); route(); } }));
  $('#demoBtn').onclick = demoData;
};
function demoData() {
  stepUpDialog({ title: 'Gerar dados de demonstração', danger: true, text: 'Isso substitui todos os jogos, produtos, jogadores, pedidos e eventos atuais por dados fictícios.', action: 'Gerar dados',
    run: async ex => { toast('Gerando dados… isso leva alguns segundos'); await api('POST', '/api/admin/demo', ex); await loadGames(); toast('Dados de demonstração prontos', 'ok'); location.hash = '#/comando'; route(); } });
}

// ---------------------------------------------------------------- Pagamentos (central de verificação)
const SEC_LABEL = {
  'admin.login': 'Login no painel', 'admin.logout': 'Saída do painel', 'admin.login_failed': 'Falha de login no painel', 'admin.2fa_failed': 'Código 2FA incorreto', 'admin.created': 'Administrador ativado',
  'admin.added': 'Administrador adicionado', 'admin.removed': 'Administrador removido', 'admin.uid_mismatch': 'Tentativa de login com conta trocada', '2fa.enabled': '2FA ativado', '2fa.disabled': '2FA desativado',
  '2fa.recovery_used': 'Código de recuperação usado', 'stepup.failed': 'Confirmação de identidade falhou', 'stepup.failed_2fa': 'Confirmação 2FA falhou', 'sessions.revoked': 'Sessões encerradas',
  'payment.mismatch': 'Pagamento com valor/pedido divergente', 'payment.manual_confirm': 'Pagamento confirmado manualmente', 'payment.e2e_reuse': 'Comprovante Pix reutilizado', 'payment.chargeback': 'Contestação (chargeback)',
  'payment.refunded': 'Estorno no provedor', 'payment.verify_requested': 'Consulta de pagamento', 'payment.charge_failed': 'Falha ao gerar cobrança', 'webhook.rejected': 'Webhook com assinatura inválida', 'webhook.unknown_order': 'Webhook de pedido desconhecido',
  'api.bad_key': 'Chave de API inválida', 'api.signature_rejected': 'Assinatura de jogo rejeitada', 'ip.blocked': 'IP bloqueado automaticamente', 'ip.unblocked': 'IP desbloqueado', 'csrf.blocked': 'Requisição de outro site bloqueada',
  'order.review_approved': 'Pedido liberado após análise', 'order.refunded': 'Pedido estornado', 'order.canceled': 'Pedido cancelado', 'order.delivered_manual': 'Entrega manual', 'order.manual_created': 'Venda manual registrada',
  'settings.changed': 'Configurações alteradas', 'game.key_rotated': 'Chave de API trocada', 'game.signing_updated': 'Assinatura do jogo alterada', 'game.deleted': 'Jogo excluído', 'game.created': 'Jogo criado', 'game.updated': 'Jogo editado',
  'product.price_changed': 'Preço alterado', 'product.created': 'Produto criado', 'product.deleted': 'Produto excluído', 'player.blocked': 'Jogador bloqueado', 'player.unblocked': 'Jogador desbloqueado', 'player.blocked_login': 'Conta bloqueada tentou entrar',
  'player.login_failed': 'Falha de login de jogador', 'export.orders': 'Exportação de pedidos', 'data.demo_generated': 'Dados de demonstração gerados',
};
state.pay = { tab: 'all', q: '', page: 1 };
PAGES.pagamentos = async (page) => {
  const f = state.pay;
  const tabs = { all: ['Todos', {}], review: ['Em análise', { review: '1' }], pending: ['Aguardando', { status: 'pending' }], provider: ['Verificados no banco', { verification: 'provider' }],
    manual: ['Conferidos à mão', { verification: 'manual' }], reported: ['Só informados pelo jogo', { verification: 'game_reported' }], refunded: ['Estornos', { status: 'refunded' }] };
  const [sum, d] = await Promise.all([api('GET', '/api/admin/payments/summary?days=30'),
    api('GET', '/api/admin/orders?' + new URLSearchParams({ ...tabs[f.tab][1], q: f.q, page: f.page, size: 25 }))]);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  page.innerHTML = pageHead('03 · OPERAÇÃO', 'Pagamentos', 'Quem pagou, quanto pagou e como cada pagamento foi comprovado.',
    `<span class="vbadge ${sum.provider === 'mercadopago' ? 'provider' : 'game_reported'}" style="height:34px;padding:0 12px">${icon(sum.provider === 'mercadopago' ? 'shield' : 'info', 13)}${sum.provider === 'mercadopago' ? 'Verificação automática ativa' : 'Pix manual — conferência no extrato'}</span>`) + `
    ${sum.review ? `<div class="banner" style="margin-bottom:14px;border-color:rgba(208,59,59,.5);background:rgba(208,59,59,.08);color:#ffb0b0">${icon('alert', 18)}<span><b>${sum.review} pedido(s) retido(s) para análise antifraude.</b> Nenhum item é entregue até você revisar.</span><button class="btn sm" id="goReview">Revisar agora</button></div>` : ''}
    <div class="kpis">
      ${[['Receita verificada', F.money(sum.verified), 'banco ou loja da plataforma', 'shield'], ['Conferida manualmente', F.money(sum.manual), 'Pix confirmado com E2E', 'check'],
        ['Sem verificação forte', F.money(sum.unverified), 'informada pelo jogo, sem assinatura', 'info'], ['Aguardando pagamento', F.money(sum.pending_amount), `${F.int(sum.pending)} pedido(s) · ${F.int(sum.expired)} expiraram`, 'pix'],
        ['Em análise', F.int(sum.review), 'retidos pelo antifraude', 'alert'], ['Divergências de valor', F.int(sum.mismatches), 'pago ≠ esperado', 'alert'],
        ['Estornado', F.money(sum.refunded), 'devolvido ao comprador', 'refresh'], ['A entregar', F.int(sum.to_deliver), 'pagos, aguardando o jogo', 'send']]
        .map(([l, v, sub, ic]) => `<section class="panel kpi"><div class="k-top">${icon(ic, 15)}<span class="label">${l}</span></div><div class="k-val">${v}</div><div class="k-bot"><span class="muted" style="font-size:11.5px">${sub} · 30 dias</span></div></section>`).join('')}
    </div>
    <div class="filters">
      <div class="seg" id="pTabs">${Object.entries(tabs).map(([k, [l]]) => `<button data-v="${k}" class="${f.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="input-group">${icon('search', 15)}<input class="input" id="pQ" placeholder="Pedido, comprador, pagador, E2E ou ID do pagamento" value="${esc(f.q)}"></div>
    </div>
    <section class="panel"><div class="panel-b flush"><div class="table-wrap">
      ${d.rows.length ? `<table class="table"><thead><tr><th>Pedido</th><th>Comprador</th><th>Pagador</th><th class="r">Esperado</th><th class="r">Recebido</th><th>Comprovação</th><th>Risco</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map(o => `<tr class="row-link" data-code="${esc(o.code)}">
          <td class="code">${esc(o.code)}<small class="muted" style="display:block;font-family:var(--font);font-size:11px">${F.dt(o.created_at)} · ${esc(o.game_name)}</small></td>
          <td>${esc(o.username || o.customer_name || '—')}<small class="muted" style="display:block;font-size:11px">${esc(o.email || (o.external_player_id ? 'ID ' + o.external_player_id : ''))}</small></td>
          <td>${esc(o.payer_name || '—')}<small class="muted mono" style="display:block;font-size:10.5px">${esc(o.e2e_id ? o.e2e_id.slice(0, 18) + '…' : o.provider_payment_id ? 'MP #' + o.provider_payment_id : L.pay[o.payment_method] || '')}</small></td>
          <td class="r">${F.money(o.total_cents)}</td>
          <td class="r">${o.paid_amount_cents == null ? '<span class="muted">—</span>' : o.paid_amount_cents === o.total_cents ? F.money(o.paid_amount_cents) : `<b style="color:#f07a7a">${F.money(o.paid_amount_cents)}</b>`}</td>
          <td>${vbadge(o)}</td><td>${riskBar(o.risk_score)}</td><td><span class="status ${o.status}">${L.status[o.status]}</span></td></tr>`).join('')}
      </tbody></table>` : emptyBox('shield', 'Nada por aqui', 'Nenhum pagamento nesta categoria.')}
    </div></div>
    <div class="panel-f"><span>${F.int(d.total)} pedido(s)</span><div class="pager">
      <button class="btn sm icon" id="pPrev" ${f.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft', 15)}</button><span class="mono">${f.page} / ${pages}</span>
      <button class="btn sm icon" id="pNext" ${f.page >= pages ? 'disabled' : ''}>${icon('chevronRight', 15)}</button></div></div></section>`;
  const re = () => PAGES.pagamentos(page);
  $$('#pTabs button').forEach(b => b.onclick = () => { f.tab = b.dataset.v; f.page = 1; re(); });
  const gr = $('#goReview'); if (gr) gr.onclick = () => { f.tab = 'review'; f.page = 1; re(); };
  $('#pQ').oninput = e => { f.q = e.target.value; f.page = 1; clearTimeout(re.t); re.t = setTimeout(async () => { await re(); const i = $('#pQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
  $('#pPrev').onclick = () => { f.page--; re(); };
  $('#pNext').onclick = () => { f.page++; re(); };
  $$('[data-code]', page).forEach(tr => tr.onclick = () => orderDrawer(tr.dataset.code));
};

// ---------------------------------------------------------------- Segurança
state.audit = { page: 1, severity: '' };
PAGES.seguranca = async (page) => {
  const [s, log] = await Promise.all([api('GET', '/api/admin/security'), api('GET', '/api/admin/audit?' + new URLSearchParams({ page: state.audit.page, severity: state.audit.severity }))]);
  const okCount = s.checks.filter(c => c.ok).length;
  const pages = Math.max(1, Math.ceil(log.total / log.size));
  const sevIc = { info: 'info', warning: 'alert', critical: 'alert' };
  page.innerHTML = pageHead('11 · SISTEMA', 'Segurança', 'Proteções ativas, verificação em duas etapas, sessões e trilha de auditoria à prova de adulteração.') + `
    <div class="kpis">
      ${[['Proteções ativas', `${okCount}/${s.checks.length}`, 'checklist abaixo', 'shield'], ['Falhas de login (7d)', F.int(s.stats.failed_logins), 'senha ou 2FA incorretos', 'lock'],
        ['Ataques bloqueados (7d)', F.int((s.stats.webhook_rejected || 0) + (s.stats.bad_signatures || 0) + (s.stats.ip_blocked || 0)), 'webhooks, assinaturas e IPs', 'alert'], ['Pedidos em análise', F.int(s.review_count), 'antifraude', 'eye']]
        .map(([l, v, sub, ic]) => `<section class="panel kpi"><div class="k-top">${icon(ic, 15)}<span class="label">${l}</span></div><div class="k-val">${v}</div><div class="k-bot"><span class="muted" style="font-size:11.5px">${sub}</span></div></section>`).join('')}
    </div>
    <div class="grid">
      ${panel('s6', '01', 'Checklist de proteção', '', '', `<ul class="checks">${s.checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}"><span class="ck">${icon(c.ok ? 'check' : 'alert', 14)}</span><div><b>${esc(c.label)}</b><small>${esc(c.hint)}</small></div></li>`).join('')}</ul>`)}
      ${panel('s6', '02', 'Verificação em duas etapas (2FA)', s.totp_enabled ? 'ativa' : 'desativada', '', s.totp_enabled
        ? `<p class="t2" style="font-size:13px">Seu login no painel pede um código do app autenticador (Google Authenticator, Authy, 1Password…). Códigos de recuperação restantes: <b style="color:var(--text)">${s.recovery_left}</b>.</p>
           <button class="btn danger" id="tfaOff" style="margin-top:14px">${icon('lock', 15)}Desativar 2FA</button>`
        : `<p class="t2" style="font-size:13px">Mesmo que alguém descubra sua senha, não entra sem o código do seu celular. <b style="color:var(--text)">Fortemente recomendado.</b></p>
           <div id="tfaBox" style="margin-top:14px"><button class="btn primary" id="tfaOn">${icon('shield', 15)}Ativar 2FA</button></div>`)}
      ${panel('s6', '03', 'Sessões abertas', 'sua conta', `<button class="btn sm" id="revAll">Encerrar as outras</button>`, `<ul class="sess">${s.sessions.map(x => `<li><span class="pi">${icon(/mobile|android|iphone/i.test(x.user_agent || '') ? 'phone' : 'monitor', 15)}</span>
        <div><b>${esc(uaName(x.user_agent))}${x.current ? ' <span class="vbadge provider">esta sessão</span>' : ''}</b><small class="mono">${esc(x.ip || '')} · ativa há ${F.ago(x.last_seen_at)} · desde ${F.dt(x.created_at)}</small></div>
        ${x.current ? '' : `<button class="btn sm ghost icon" data-rev="${x.id}" title="Encerrar">${icon('close', 15)}</button>`}</li>`).join('')}</ul>
        <p class="muted" style="font-size:12px;margin-top:10px">Sessões do painel expiram após ${state.me.idle_minutes} min sem uso e no máximo em 12 h.</p>`)}
      ${panel('s6', '04', 'IPs bloqueados', 'bloqueio automático por abuso', '', s.blocked.length ? `<ul class="sess">${s.blocked.map(b => `<li><span class="pi">${icon('globe', 15)}</span><div><b class="mono">${esc(b.ip)}</b><small>até ${F.dt(b.until)}</small></div><button class="btn sm" data-unb="${esc(b.ip)}">Desbloquear</button></li>`).join('')}</ul>`
        : '<p class="t2" style="font-size:13px">Nenhum IP bloqueado agora. Quem excede repetidamente os limites de requisição é bloqueado por 15 minutos.</p>')}
      ${panel('s12', '05', 'Trilha de auditoria', `${F.int(s.chain.records)} registros · cadeia de hash ${s.chain.ok ? '<span style="color:var(--good-text)">íntegra</span>' : `<b style="color:#f07a7a">QUEBRADA no registro #${s.chain.broken_at}</b>`}`,
        `<div class="seg" id="sevSeg">${[['', 'Tudo'], ['critical', 'Crítico'], ['warning', 'Atenção'], ['info', 'Info']].map(([k, l]) => `<button data-v="${k}" class="${state.audit.severity === k ? 'on' : ''}">${l}</button>`).join('')}</div>`,
        `<div class="table-wrap"><table class="table"><thead><tr><th>Quando</th><th>Evento</th><th>Quem</th><th>Alvo</th><th>IP</th><th>Hash</th></tr></thead><tbody>
        ${log.rows.map(r => `<tr><td class="mono t2" style="font-size:12px;white-space:nowrap">${F.dt(r.at)}</td>
          <td><span class="sev ${r.severity}">${icon(sevIc[r.severity], 13)}</span>${esc(SEC_LABEL[r.action] || r.action)}</td>
          <td class="t2">${esc(r.actor_name || (r.actor_type === 'system' ? 'sistema' : r.actor_type === 'anon' ? 'anônimo' : r.actor_type + (r.actor_id ? ' #' + r.actor_id : '')))}</td>
          <td class="mono t2" style="font-size:12px">${esc(r.target || '')}</td><td class="mono t2" style="font-size:12px">${esc(r.ip || '')}</td><td class="mono muted" style="font-size:11px" title="${esc(r.hash)}">${esc(r.hash.slice(0, 10))}…</td></tr>`).join('')}
        </tbody></table></div><div class="panel-f"><span>Cada registro carrega o hash do anterior: qualquer alteração no banco quebra a cadeia.</span><div class="pager">
        <button class="btn sm icon" id="aPrev" ${state.audit.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft', 15)}</button><span class="mono">${state.audit.page} / ${pages}</span>
        <button class="btn sm icon" id="aNext" ${state.audit.page >= pages ? 'disabled' : ''}>${icon('chevronRight', 15)}</button></div></div>`, 'flush')}
    </div>`;
  const re = () => PAGES.seguranca(page);
  $$('#sevSeg button').forEach(b => b.onclick = () => { state.audit = { page: 1, severity: b.dataset.v }; re(); });
  $('#aPrev').onclick = () => { state.audit.page--; re(); };
  $('#aNext').onclick = () => { state.audit.page++; re(); };
  $('#revAll').onclick = async () => { await api('POST', '/api/admin/sessions/revoke', { all: true }); toast('Outras sessões encerradas', 'ok'); re(); };
  $$('[data-rev]').forEach(b => b.onclick = async () => { await api('POST', '/api/admin/sessions/revoke', { id: b.dataset.rev }); toast('Sessão encerrada', 'ok'); re(); });
  $$('[data-unb]').forEach(b => b.onclick = async () => { await api('POST', '/api/admin/security/unblock', { ip: b.dataset.unb }); toast('IP desbloqueado', 'ok'); re(); });
  const off = $('#tfaOff'); if (off) off.onclick = () => stepUpDialog({ title: 'Desativar 2FA', danger: true, text: 'Sua conta volta a depender só da senha/Google. Não recomendado.', action: 'Desativar',
    run: async ex => { await api('POST', '/api/admin/2fa/disable', ex); state.me.totp_enabled = false; toast('2FA desativado', 'ok'); re(); } });
  const on = $('#tfaOn'); if (on) on.onclick = async () => {
    const r = await api('POST', '/api/admin/2fa/setup');
    let qr = ''; try { const q = qrcode(0, 'M'); q.addData(r.uri); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch { }
    $('#tfaBox').innerHTML = `<div class="tfa"><div class="qr-s">${qr}</div><div style="display:flex;flex-direction:column;gap:10px;min-width:0">
      <p class="t2" style="font-size:12.5px">1. Escaneie o QR Code no app autenticador.<br>2. Ou digite a chave: <code style="word-break:break-all">${esc(r.secret)}</code><br>3. Informe o código de 6 dígitos:</p>
      <form id="tfaForm" style="display:flex;gap:8px"><input class="input mono" name="code" maxlength="6" inputmode="numeric" style="letter-spacing:.25em;max-width:140px"><button class="btn primary">Ativar</button></form>
      <div class="nxl-msg err" id="tfaErr"></div></div></div>`;
    $('#tfaForm').onsubmit = async e => {
      e.preventDefault();
      try {
        const res = await api('POST', '/api/admin/2fa/enable', formData(e.target));
        state.me.totp_enabled = true;
        $('#layer').innerHTML = `<div class="overlay"><div class="dialog" style="max-width:520px"><div class="dialog-h"><h3>2FA ativado — guarde seus códigos de recuperação</h3></div>
          <div class="dialog-b"><p class="t2" style="font-size:13px;margin-bottom:14px">Se perder o celular, cada código abaixo permite <b style="color:var(--text)">um</b> acesso. Guarde em local seguro. Eles não serão mostrados de novo.</p>
          <div class="codes">${res.recovery_codes.map(c => `<code>${esc(c)}</code>`).join('')}</div></div>
          <div class="dialog-f"><button class="btn" id="cpCodes">${icon('copy', 15)}Copiar</button><button class="btn primary" data-x>Guardei os códigos</button></div></div></div>`;
        $('#cpCodes').onclick = () => copy(res.recovery_codes.join('\n'));
        $$('#layer [data-x]').forEach(b => b.onclick = () => { closeLayer(); re(); });
      } catch (err) { $('#tfaErr').textContent = err.message; }
    };
  };
};
const uaName = ua => { ua = ua || ''; const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''; return o ? `${b} · ${o}` : b; };

// ============================================================ paleta de comandos (Ctrl K)
function commandPalette() {
  const items = [
    ...NAV.flatMap(([, it]) => it.map(([k, t, ic]) => ({ t, ic, hint: 'Ir para', run: () => { location.hash = '#/' + k; } }))),
    { t: 'Novo jogo', ic: 'plus', hint: 'Ação', run: () => { location.hash = '#/jogos'; setTimeout(() => gameForm(), 120); } },
    { t: 'Novo produto', ic: 'plus', hint: 'Ação', run: () => { location.hash = '#/produtos'; setTimeout(() => productForm({ game_id: state.games[0]?.id }), 120); } },
    { t: 'Registrar venda manual', ic: 'receipt', hint: 'Ação', run: () => { location.hash = '#/pedidos'; setTimeout(manualOrder, 150); } },
    { t: 'Pedidos a entregar', ic: 'send', hint: 'Filtro', run: () => { state.orders = { ...state.orders, status: 'paid', page: 1 }; location.hash = '#/pedidos'; route(); } },
    { t: 'Abrir site público', ic: 'external', hint: 'Link', run: () => window.open('/', '_blank') },
    { t: 'Exportar pedidos (CSV)', ic: 'download', hint: 'Ação', run: () => { location.href = '/api/admin/export/orders.csv'; } },
    ...state.games.map(g => ({ t: `${g.name} — estatísticas`, ic: 'gamepad', hint: 'Jogo', run: () => { state.game = String(g.id); location.hash = '#/comando'; route(); } })),
  ];
  const layer = $('#layer');
  layer.innerHTML = `<div class="overlay" style="place-items:start center"><div class="cmdk" role="dialog" aria-label="Comandos">
    <div class="cmdk-in">${icon('search', 18)}<input placeholder="Buscar páginas, ações e jogos…" aria-label="Buscar"><span class="kbd">ESC</span></div>
    <div class="cmdk-list" id="cmdkList"></div></div></div>`;
  const input = $('input', layer), list = $('#cmdkList');
  let sel = 0, filtered = items;
  const draw = () => {
    list.innerHTML = filtered.map((it, i) => `<div class="cmdk-item ${i === sel ? 'on' : ''}" data-i="${i}">${icon(it.ic, 16)}<span>${esc(it.t)}</span><span class="label">${it.hint}</span></div>`).join('') || '<div class="empty" style="padding:24px">Nada encontrado</div>';
    $$('.cmdk-item', list).forEach(el => { el.onclick = () => { closeLayer(); filtered[+el.dataset.i].run(); }; el.onmousemove = () => { if (sel !== +el.dataset.i) { sel = +el.dataset.i; draw(); } }; });
  };
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  input.oninput = () => { const q = norm(input.value); filtered = items.filter(it => norm(it.t).includes(q)); sel = 0; draw(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(filtered.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && filtered[sel]) { closeLayer(); filtered[sel].run(); }
  };
  $('.overlay', layer).addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) closeLayer(); });
  draw(); input.focus();
}

// ============================================================ tempo real
let streamOk = false, es;
function connectStream() {
  if (es) es.close();
  es = new EventSource('/api/admin/stream');
  const led = (on) => { streamOk = on; $('#ledStream').className = 'led ' + (on ? 'on' : 'off'); const c = $('#lvConn'); if (c) { c.className = 'status ' + (on ? 'delivered' : 'canceled'); c.textContent = on ? 'Conectado' : 'Reconectando…'; } };
  es.onopen = () => led(true);
  es.onerror = () => led(false);
  es.addEventListener('order', e => {
    const d = JSON.parse(e.data);
    liveTick('order', d);
    toast(`${d.status === 'pending' ? 'Novo pedido' : 'Nova venda'} · ${d.game} · ${F.money(d.total_cents)}`, d.status === 'pending' ? '' : 'ok');
    const item = { kind: 'order', code: d.code, status: d.status, total_cents: d.total_cents, coins_total: d.coins, channel: d.channel, at: d.at, game: d.game };
    ['#feed', '#lvFeed'].forEach(id => { const ul = $(id); if (ul) ul.insertAdjacentHTML('afterbegin', feedItem(item, true)); });
    refreshPendingBadge();
  });
  es.addEventListener('event', e => {
    const d = JSON.parse(e.data);
    liveTick('event', d);
    if (d.type === 'page_view') return;
    const g = state.games.find(x => x.id === d.game_id);
    const item = { kind: 'event', type: d.type, platform: d.platform, at: d.at, game: g?.name };
    ['#feed', '#lvFeed'].forEach(id => { const ul = $(id); if (ul) ul.insertAdjacentHTML('afterbegin', feedItem(item, true)); });
  });
  es.addEventListener('order_status', e => { const d = JSON.parse(e.data); if (d.status === 'paid' && d.prev === 'pending') toast(`Pagamento confirmado · ${d.code} · ${F.money(d.total_cents)}`, 'ok'); refreshPendingBadge(); });
  es.addEventListener('security', e => { const d = JSON.parse(e.data); if (d.severity === 'critical') toast(`Alerta de segurança: ${SEC_LABEL[d.action] || d.action}${d.target ? ' · ' + d.target : ''}`, 'err'); });
}

// ============================================================ autenticação (Firebase)
const AUTH_ART = () => `<div class="auth-art">
      <svg class="bg" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        ${[...Array(12)].map((_, i) => `<circle cx="470" cy="260" r="${50 + i * 46}" fill="none" stroke="#3987e5" stroke-opacity="${0.42 - i * 0.03}" ${i % 2 ? 'stroke-dasharray="2 7"' : ''}/>`).join('')}
        <path d="M470 0V800M0 260H600" stroke="#3987e5" stroke-opacity=".2"/>
        ${[...Array(40)].map((_, i) => `<path d="M${40 + i * 13} 760v${i % 5 ? -5 : -12}" stroke="#fff" stroke-opacity=".25"/>`).join('')}
      </svg>
      <div style="display:flex;align-items:center;gap:12px"><img src="/assets/logo.svg" width="32" height="32" alt=""><b style="letter-spacing:.2em">NEXUS</b><span class="label">Control</span></div>
      <div><span class="label" style="color:var(--accent)">Acesso restrito · administradores</span><h2 style="margin-top:14px">Todos os seus jogos, vendas e jogadores em um só painel.</h2>
        <p>Login protegido pelo Firebase, e-mail verificado, verificação em duas etapas e auditoria de cada ação.</p></div>
      <div class="label">${icon('shield', 13)} Conexão monitorada · tentativas registradas</div>
    </div>`;
async function showAuth(view = 'login', data = {}) {
  $('#app').classList.add('hidden');
  es?.close();
  const auth = $('#auth');
  auth.classList.remove('hidden');
  auth.innerHTML = AUTH_ART() + '<div class="auth-form"><div class="auth-box" id="authBox"></div></div>';
  const box = $('#authBox');
  if (view === 'login') {
    NXLogin(box, { title: 'Entrar no painel', kicker: data.notice ? 'Sessão expirada' : 'Acesso restrito',
      subtitle: data.notice ? 'Por segurança, o painel desconecta após 30 min sem uso. Entre de novo.' : 'Use o e-mail cadastrado como administrador.', onDone: r => {
      if (r.mfa_required) return showAuth('mfa', r);
      if (r.is_admin) return boot();
      showAuth('denied', r);
    } });
  } else if (view === 'mfa') {
    box.innerHTML = `<form class="nxl" novalidate><div class="nxl-h"><span class="label">${data.expired ? 'Sessão do painel expirada' : 'Etapa 2 de 2'}</span><h2>Verificação em duas etapas</h2><p>${data.expired ? 'Você ficou um tempo sem usar o painel. ' : ''}Digite o código de 6 dígitos do seu app autenticador, ou um código de recuperação.</p></div>
      <input class="input mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="14" style="height:52px;font-size:22px;letter-spacing:.35em;text-align:center">
      <div class="nxl-msg err" id="mErr"></div><button class="btn primary lg">Verificar</button><a href="#" class="nxl-link" id="back">Usar outra conta</a></form>`;
    $('form', box).onsubmit = async e => { e.preventDefault(); try { await NXAuth.mfa(data.mfa_token, formData(e.target).code); boot(); } catch (err) { $('#mErr').textContent = err.message; } };
    $('#back').onclick = async e => { e.preventDefault(); await (await NXWhenAuth()).logout(); showAuth(); };
    $('input', box).focus();
  } else {
    box.innerHTML = `<div class="nxl"><div class="nxl-h"><span class="label" style="color:var(--warning)">Sem permissão</span><h2>Esta conta não é de administrador</h2>
      <p>${esc(data.admin_pending || 'Você entrou como jogador. O painel é exclusivo para e-mails autorizados pelo dono do sistema.')}</p></div>
      <a class="btn primary lg" href="/mercado">${icon('cart', 16)}Ir para a loja</a><button class="btn lg" id="other">Entrar com outra conta</button></div>`;
    $('#other').onclick = async () => { await (await NXWhenAuth()).logout(); showAuth(); };
  }
}

// a sessão do painel expira após inatividade; a pessoa continua logada no Firebase → reconecta
let resuming = false;
async function resumeAdmin() {
  if (resuming) return showAuth('login', { notice: true });
  resuming = true;
  try {
    const A = await NXWhenAuth();
    const r = await A.resume();
    if (r?.mfa_required) return showAuth('mfa', { ...r, expired: true });
    if (r?.is_admin) return boot();
  } catch { }
  finally { setTimeout(() => { resuming = false; }, 3000); }
  showAuth('login', { notice: true });
}
async function boot() {
  try { state.me = await api('GET', '/api/admin/me'); }
  catch {
    state.me = null;
    try {
      const m = await api('GET', '/api/auth/me');
      if (m.player && m.admin_eligible) return resumeAdmin();
      if (m.player) return showAuth('denied');
    } catch { }
    return showAuth();
  }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const ini = (state.me.name || state.me.email).split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
  $('#me').innerHTML = `<span class="av">${esc(ini)}</span><div class="who"><b>${esc(state.me.name)}</b><span>${esc(state.me.email)}</span></div><button class="btn ghost icon sm" id="logout" title="Sair">${icon('logout', 16)}</button>`;
  $('#logout').onclick = async () => { await (await NXWhenAuth()).logout(); state.me = null; es?.close(); showAuth(); };
  await loadGames();
  connectStream();
  route();
  if (!state.me.totp_enabled) setTimeout(() => toast('Recomendado: ative a verificação em duas etapas em Segurança.'), 1500);
}

// shell
$('#railToggle').innerHTML = icon('sidebar', 17);
$('#cmdkIcon').innerHTML = icon('search', 15);
$('#railToggle').onclick = () => {
  if (window.innerWidth <= 900) $('#app').classList.toggle('mobile-open');
  else { $('#app').classList.toggle('collapsed'); try { localStorage.setItem('nx_rail', $('#app').classList.contains('collapsed') ? '1' : ''); } catch { } }
};
try { if (localStorage.getItem('nx_rail')) $('#app').classList.add('collapsed'); } catch { }
$('#cmdkBtn').onclick = commandPalette;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.me) commandPalette(); }
  if (e.key === 'Escape') closeLayer();
});
window.addEventListener('hashchange', () => state.me && route());
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR') + ' BRT'; }, 1000);
boot();
