// Painel administrativo
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ui = {
  view: 'visao',
  filtros: { lojaId: '', status: '', busca: '', periodo: '30' },

  toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  },

  modal(titulo, html, onSubmit) {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-bg">
        <form class="modal" novalidate>
          <div class="row between"><h2>${titulo}</h2><button type="button" class="btn ghost sm" data-close>✕</button></div>
          ${html}
          <div class="actions">
            <button type="button" class="btn" data-close>Cancelar</button>
            ${onSubmit ? '<button type="submit" class="btn primary">Salvar</button>' : ''}
          </div>
        </form>
      </div>`;
    const form = $('form', root);
    const close = () => (root.innerHTML = '');
    $$('[data-close]', root).forEach(b => (b.onclick = close));
    $('.modal-bg', root).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) close(); });
    form.onsubmit = e => {
      e.preventDefault();
      if (!onSubmit) return close();
      const data = Object.fromEntries(new FormData(form).entries());
      $$('input[type=checkbox]', form).forEach(c => (data[c.name] = c.checked));
      if (onSubmit(data, form) !== false) close();
    };
    const first = $('input, select, textarea', form);
    if (first) first.focus();
    return form;
  },

  confirmar(msg) { return window.confirm(msg); },
};

const lojaUrl = l => `loja.html?loja=${encodeURIComponent(l.slug || l.id)}`;

function lojaOptions(sel, incluirTodas = true) {
  return (incluirTodas ? '<option value="">Todas as lojas</option>' : '') +
    DB.lojas().map(l => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${fmt.esc(l.nome)}</option>`).join('');
}

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function receitaValida(p) { return p.status === 'pago' || p.status === 'entregue'; }

// ======================= VIEWS =======================
const views = {
  // ---------------- Visão geral ----------------
  visao() {
    const dias = Number(ui.filtros.periodo);
    const desde = Date.now() - dias * 86400000;
    const lojaId = ui.filtros.lojaId;
    const pedidos = DB.pedidos(lojaId).filter(p => new Date(p.data).getTime() >= desde);
    const validos = pedidos.filter(receitaValida);
    const receita = validos.reduce((s, p) => s + p.total, 0);
    const ticket = validos.length ? receita / validos.length : 0;
    const pendentes = pedidos.filter(p => p.status === 'pendente').length;
    const pagosAEntregar = pedidos.filter(p => p.status === 'pago').length;

    setTop('Visão geral', `Últimos ${dias} dias`, `
      <select id="fLoja" style="width:auto">${lojaOptions(lojaId)}</select>
      <select id="fPeriodo" style="width:auto">
        ${[7, 14, 30, 90, 365].map(d => `<option value="${d}" ${String(d) === ui.filtros.periodo ? 'selected' : ''}>${d} dias</option>`).join('')}
      </select>`);
    $('#fLoja').onchange = e => { ui.filtros.lojaId = e.target.value; render(); };
    $('#fPeriodo').onchange = e => { ui.filtros.periodo = e.target.value; render(); };

    if (!DB.lojas().length) {
      return `<div class="card empty"><div class="big">🏪</div>
        <h2>Bem-vindo ao seu painel!</h2>
        <p>Crie sua primeira loja de jogo para começar a vender moedas, skins e itens.</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" onclick="acoes.novaLoja()">+ Criar loja</button>
          <button class="btn" onclick="acoes.carregarDemo()">Carregar dados de exemplo</button>
        </div></div>`;
    }

    // vendas por dia
    const nDias = Math.min(dias, 30);
    const porDia = [];
    for (let i = nDias - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      porDia.push({ key, label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), v: 0 });
    }
    validos.forEach(p => {
      const dia = porDia.find(x => x.key === new Date(p.data).toISOString().slice(0, 10));
      if (dia) dia.v += p.total;
    });

    // top produtos
    const top = {};
    validos.forEach(p => p.itens.forEach(it => {
      top[it.nome] ||= { nome: it.nome, qtd: 0, total: 0 };
      top[it.nome].qtd += it.qtd;
      top[it.nome].total += it.preco * it.qtd;
    }));
    const topList = Object.values(top).sort((a, b) => b.total - a.total).slice(0, 6);

    // por loja
    const porLoja = DB.lojas().map(l => ({
      l, total: validos.filter(p => p.lojaId === l.id).reduce((s, p) => s + p.total, 0),
      n: validos.filter(p => p.lojaId === l.id).length,
    })).sort((a, b) => b.total - a.total);

    return `
      <div class="grid kpis">
        ${kpi('Receita', fmt.money(receita), `${validos.length} vendas pagas`)}
        ${kpi('Ticket médio', fmt.money(ticket), 'por pedido')}
        ${kpi('Pedidos', pedidos.length, `${pendentes} aguardando pagamento`)}
        ${kpi('A entregar', pagosAEntregar, 'pagos, ainda não entregues')}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="row between"><h2>Receita por dia</h2><small>últimos ${nDias} dias</small></div>
          ${barChart(porDia)}
        </div>
        <div class="card">
          <h2>Mais vendidos</h2>
          ${topList.length ? `<ul class="rank">${topList.map(t => `
            <li><span>${fmt.esc(t.nome)} <small>×${t.qtd}</small></span><b>${fmt.money(t.total)}</b></li>`).join('')}</ul>`
            : '<p class="muted">Sem vendas no período.</p>'}
        </div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="row between"><h2>Últimos pedidos</h2><a href="#" onclick="go('pedidos');return false">ver todos →</a></div>
          ${tabelaPedidos(DB.pedidos(lojaId).slice(0, 6), true)}
        </div>
        <div class="card">
          <h2>Receita por loja</h2>
          <ul class="rank">${porLoja.map(x => `
            <li><span>${fmt.esc(x.l.logo && !/^http/.test(x.l.logo) ? x.l.logo : '🏪')} ${fmt.esc(x.l.nome)} <small>${x.n} vendas</small></span><b>${fmt.money(x.total)}</b></li>`).join('')}</ul>
        </div>
      </div>`;
  },

  // ---------------- Lojas ----------------
  lojas() {
    setTop('Minhas lojas', `${DB.lojas().length} loja(s)`, `<button class="btn primary" onclick="acoes.novaLoja()">+ Nova loja</button>`);
    const lojas = DB.lojas();
    if (!lojas.length) {
      return `<div class="card empty"><div class="big">🏪</div><p>Você ainda não tem lojas.</p>
        <button class="btn primary" onclick="acoes.novaLoja()">+ Criar primeira loja</button></div>`;
    }
    return `<div class="grid cards">${lojas.map(l => {
      const prods = DB.produtos(l.id);
      const vendas = DB.pedidos(l.id).filter(receitaValida);
      const receita = vendas.reduce((s, p) => s + p.total, 0);
      return `
      <div class="card store-card" style="--c:${fmt.esc(l.cor || '#8b5cf6')}">
        <div class="head">
          <div class="thumb">${imgOrEmoji(l.logo)}</div>
          <div style="min-width:0">
            <h2 style="margin:0">${fmt.esc(l.nome)}</h2>
            <small>${fmt.esc(l.jogo || '')}</small>
          </div>
          <span class="badge ${l.ativa ? 'on' : 'off'}" style="margin-left:auto">${l.ativa ? 'Ativa' : 'Pausada'}</span>
        </div>
        <small>${fmt.esc(l.descricao || '')}</small>
        <div class="stats">
          <div><b>${prods.length}</b>produtos</div>
          <div><b>${vendas.length}</b>vendas</div>
          <div><b>${fmt.money(receita)}</b>receita</div>
        </div>
        <div class="row">
          <a class="btn sm primary" href="${lojaUrl(l)}" target="_blank">Abrir loja ↗</a>
          <button class="btn sm" onclick="acoes.verProdutos('${l.id}')">Produtos</button>
          <button class="btn sm" onclick="acoes.editarLoja('${l.id}')">Editar</button>
          <button class="btn sm danger" onclick="acoes.removerLoja('${l.id}')">Excluir</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  },

  // ---------------- Produtos ----------------
  produtos() {
    setTop('Produtos', 'Moedas, skins, itens e mais', DB.lojas().length
      ? `<button class="btn primary" onclick="acoes.novoProduto()">+ Novo produto</button>` : '');
    if (!DB.lojas().length) {
      return `<div class="card empty"><div class="big">🪙</div><p>Crie uma loja antes de cadastrar produtos.</p>
        <button class="btn primary" onclick="acoes.novaLoja()">+ Criar loja</button></div>`;
    }
    const f = ui.filtros;
    let lista = DB.produtos(f.lojaId);
    if (f.categoria) lista = lista.filter(p => p.categoria === f.categoria);
    if (f.busca) lista = lista.filter(p => p.nome.toLowerCase().includes(f.busca.toLowerCase()));

    return `
      <div class="filters">
        <select id="pfLoja">${lojaOptions(f.lojaId)}</select>
        <select id="pfCat"><option value="">Todas as categorias</option>
          ${Object.entries(CATEGORIAS).map(([k, v]) => `<option value="${k}" ${f.categoria === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input id="pfBusca" placeholder="Buscar produto..." value="${fmt.esc(f.busca)}">
      </div>
      <div class="card table-wrap">
        ${lista.length ? `<table>
          <thead><tr><th></th><th>Produto</th><th>Loja</th><th>Categoria</th><th class="num">Preço</th><th class="num">Estoque</th><th>Status</th><th></th></tr></thead>
          <tbody>${lista.map(p => {
            const l = DB.loja(p.lojaId);
            return `<tr>
              <td><div class="thumb">${imgOrEmoji(p.imagem)}</div></td>
              <td><b>${fmt.esc(p.nome)}</b>${p.destaque ? ' ⭐' : ''}<br><small>${fmt.esc(p.descricao || '')}</small></td>
              <td>${fmt.esc(l ? l.nome : '—')}</td>
              <td>${CATEGORIAS[p.categoria] || p.categoria}</td>
              <td class="num">${fmt.money(p.preco)}${p.precoAntigo ? `<br><small style="text-decoration:line-through">${fmt.money(p.precoAntigo)}</small>` : ''}</td>
              <td class="num">${p.estoque === '' || p.estoque == null ? '∞' : p.estoque}</td>
              <td><span class="badge ${p.ativo ? 'on' : 'off'}">${p.ativo ? 'À venda' : 'Oculto'}</span></td>
              <td class="num"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
                <button class="btn sm" onclick="acoes.editarProduto('${p.id}')">Editar</button>
                <button class="btn sm" onclick="acoes.duplicarProduto('${p.id}')" title="Duplicar">⧉</button>
                <button class="btn sm danger" onclick="acoes.removerProduto('${p.id}')">✕</button>
              </div></td></tr>`;
          }).join('')}</tbody></table>`
        : '<div class="empty">Nenhum produto encontrado.</div>'}
      </div>`;
  },

  // ---------------- Pedidos ----------------
  pedidos() {
    setTop('Pedidos', 'Acompanhe pagamentos e entregas', DB.lojas().length
      ? `<button class="btn" onclick="acoes.exportarCSV()">⬇ CSV</button><button class="btn primary" onclick="acoes.novoPedido()">+ Venda manual</button>` : '');
    const f = ui.filtros;
    let lista = DB.pedidos(f.lojaId);
    if (f.status) lista = lista.filter(p => p.status === f.status);
    if (f.busca) {
      const q = f.busca.toLowerCase();
      lista = lista.filter(p => (p.id + ' ' + p.cliente.nome + ' ' + (p.cliente.nick || '')).toLowerCase().includes(q));
    }
    return `
      <div class="filters">
        <select id="pfLoja">${lojaOptions(f.lojaId)}</select>
        <select id="pfStatus"><option value="">Todos os status</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input id="pfBusca" placeholder="Buscar por código, cliente ou nick..." value="${fmt.esc(f.busca)}">
      </div>
      <div class="card table-wrap">${tabelaPedidos(lista)}</div>`;
  },

  // ---------------- Configurações ----------------
  config() {
    setTop('Configurações', 'Backup, publicação e dados', '');
    return `
      <div class="grid two">
        <div class="card">
          <h2>Backup dos dados</h2>
          <p class="muted">Seus dados ficam salvos neste navegador. Exporte um backup regularmente.</p>
          <div class="row">
            <button class="btn primary" onclick="acoes.exportar()">⬇ Exportar JSON</button>
            <label class="btn" style="margin:0;color:var(--text)">⬆ Importar JSON
              <input type="file" accept=".json,application/json" id="importFile" hidden></label>
          </div>
          <hr style="border-color:var(--border);margin:20px 0">
          <h2>Publicar suas lojas</h2>
          <p class="muted">Para que clientes de qualquer lugar vejam suas lojas, exporte o JSON, salve como
            <code>data/lojas.json</code> no repositório e publique no GitHub Pages (ou qualquer hospedagem estática).
            As páginas das lojas carregam esse arquivo automaticamente.</p>
        </div>
        <div class="card">
          <h2>Dados de exemplo</h2>
          <p class="muted">Adiciona 2 lojas, produtos e pedidos fictícios para testar o painel.</p>
          <button class="btn" onclick="acoes.carregarDemo()">Carregar exemplo</button>
          <hr style="border-color:var(--border);margin:20px 0">
          <h2 style="color:var(--bad)">Zona de perigo</h2>
          <p class="muted">Apaga todas as lojas, produtos e pedidos deste navegador.</p>
          <button class="btn danger" onclick="acoes.limparTudo()">Apagar tudo</button>
        </div>
      </div>`;
  },
};

// ======================= HELPERS DE RENDER =======================
function kpi(label, value, sub) {
  return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function barChart(data) {
  const W = 640, H = 220, pad = { l: 50, r: 8, t: 10, b: 26 };
  const max = Math.max(...data.map(d => d.v), 1);
  const nice = Math.ceil(max / 10 ** Math.floor(Math.log10(max))) * 10 ** Math.floor(Math.log10(max));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bw = iw / data.length;
  const ticks = [0, .5, 1].map(f => f * nice);
  const step = Math.ceil(data.length / 8);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Receita por dia">
    ${ticks.map(t => {
      const y = pad.t + ih - (t / nice) * ih;
      return `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>
        <text x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${t >= 1000 ? (t / 1000).toFixed(1) + 'k' : Math.round(t)}</text>`;
    }).join('')}
    ${data.map((d, i) => {
      const h = (d.v / nice) * ih;
      const x = pad.l + i * bw + bw * 0.15;
      return `<rect class="bar" x="${x}" y="${pad.t + ih - h}" width="${bw * 0.7}" height="${Math.max(h, 0)}" rx="3"><title>${d.label}: ${fmt.money(d.v)}</title></rect>
        ${i % step === 0 ? `<text x="${x + bw * 0.35}" y="${H - 8}" text-anchor="middle">${d.label}</text>` : ''}`;
    }).join('')}
  </svg>`;
}

function tabelaPedidos(lista, compacto = false) {
  if (!lista.length) return '<div class="empty">Nenhum pedido ainda.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Pedido</th>${compacto ? '' : '<th>Data</th><th>Loja</th>'}<th>Cliente</th>${compacto ? '' : '<th>Itens</th>'}<th class="num">Total</th><th>Status</th>${compacto ? '' : '<th></th>'}</tr></thead>
    <tbody>${lista.map(p => {
      const l = DB.loja(p.lojaId);
      return `<tr>
        <td><a href="#" onclick="acoes.verPedido('${p.id}');return false"><b>${p.id}</b></a>${compacto ? `<br><small>${fmt.date(p.data)}</small>` : ''}</td>
        ${compacto ? '' : `<td><small>${fmt.date(p.data)}</small></td><td>${fmt.esc(l ? l.nome : '—')}</td>`}
        <td>${fmt.esc(p.cliente.nome)}${p.cliente.nick ? `<br><small>🎮 ${fmt.esc(p.cliente.nick)}</small>` : ''}</td>
        ${compacto ? '' : `<td><small>${p.itens.map(i => `${i.qtd}× ${fmt.esc(i.nome)}`).join('<br>')}</small></td>`}
        <td class="num"><b>${fmt.money(p.total)}</b></td>
        <td>${compacto ? `<span class="badge ${p.status}">${STATUS[p.status]}</span>` : `
          <select class="status-select" onchange="acoes.mudarStatus('${p.id}', this.value)">
            ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>`}</td>
        ${compacto ? '' : `<td class="num"><button class="btn sm danger" onclick="acoes.removerPedido('${p.id}')">✕</button></td>`}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function setTop(titulo, sub, acoesHtml) {
  $('#viewTitle').textContent = titulo;
  $('#viewSub').textContent = sub;
  $('#topActions').innerHTML = acoesHtml;
}

// ======================= AÇÕES =======================
const acoes = {
  formLoja(l = {}) {
    return `
      <div class="fields">
        <div class="field"><label>Nome da loja *</label><input name="nome" required value="${fmt.esc(l.nome)}"></div>
        <div class="field"><label>Jogo</label><input name="jogo" placeholder="Ex.: Meu Jogo RPG" value="${fmt.esc(l.jogo)}"></div>
      </div>
      <div class="field"><label>Descrição</label><textarea name="descricao" rows="2">${fmt.esc(l.descricao)}</textarea></div>
      <div class="fields">
        <div class="field"><label>Logo (emoji ou URL da imagem)</label><input name="logo" value="${fmt.esc(l.logo || '🎮')}"></div>
        <div class="field"><label>Cor do tema</label><input type="color" name="cor" value="${fmt.esc(l.cor || '#8b5cf6')}"></div>
        <div class="field"><label>Endereço (slug)</label><input name="slug" placeholder="minha-loja" value="${fmt.esc(l.slug)}"></div>
        <div class="field"><label>WhatsApp p/ pedidos (com DDI)</label><input name="whatsapp" placeholder="5511999999999" value="${fmt.esc(l.whatsapp)}"></div>
        <div class="field"><label>Chave Pix</label><input name="pix" value="${fmt.esc(l.pix)}"></div>
        <div class="field"><label>Discord (link)</label><input name="discord" value="${fmt.esc(l.discord)}"></div>
      </div>
      <label class="check"><input type="checkbox" name="ativa" ${l.ativa !== false ? 'checked' : ''}> Loja ativa (aceitando pedidos)</label>`;
  },

  salvarLojaForm(id) {
    return d => {
      if (!d.nome.trim()) { ui.toast('Informe o nome da loja'); return false; }
      d.slug = slugify(d.slug || d.nome);
      const dup = DB.lojas().find(x => x.slug === d.slug && x.id !== id);
      if (dup) { ui.toast('Já existe uma loja com esse endereço'); return false; }
      d.whatsapp = (d.whatsapp || '').replace(/\D/g, '');
      DB.salvarLoja(id ? { ...d, id } : d);
      ui.toast(id ? 'Loja atualizada' : 'Loja criada!');
      render();
    };
  },
  novaLoja() { ui.modal('Nova loja', this.formLoja(), this.salvarLojaForm()); },
  editarLoja(id) { ui.modal('Editar loja', this.formLoja(DB.loja(id)), this.salvarLojaForm(id)); },
  removerLoja(id) {
    const l = DB.loja(id);
    if (ui.confirmar(`Excluir a loja "${l.nome}" e todos os seus produtos?`)) { DB.removerLoja(id); ui.toast('Loja excluída'); render(); }
  },
  verProdutos(id) { ui.filtros.lojaId = id; go('produtos'); },

  formProduto(p = {}) {
    return `
      <div class="field"><label>Loja *</label><select name="lojaId">${lojaOptions(p.lojaId || ui.filtros.lojaId, false)}</select></div>
      <div class="fields">
        <div class="field"><label>Nome *</label><input name="nome" required placeholder="Ex.: 1.000 Moedas" value="${fmt.esc(p.nome)}"></div>
        <div class="field"><label>Categoria</label><select name="categoria">
          ${Object.entries(CATEGORIAS).map(([k, v]) => `<option value="${k}" ${p.categoria === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Preço (R$) *</label><input name="preco" type="number" step="0.01" min="0" required value="${p.preco ?? ''}"></div>
        <div class="field"><label>Preço antigo (promoção)</label><input name="precoAntigo" type="number" step="0.01" min="0" value="${p.precoAntigo ?? ''}"></div>
        <div class="field"><label>Estoque (vazio = ilimitado)</label><input name="estoque" type="number" min="0" value="${p.estoque ?? ''}"></div>
        <div class="field"><label>Imagem (emoji ou URL)</label><input name="imagem" value="${fmt.esc(p.imagem || '🪙')}"></div>
      </div>
      <div class="field"><label>Descrição</label><textarea name="descricao" rows="2">${fmt.esc(p.descricao)}</textarea></div>
      <div class="row" style="gap:20px">
        <label class="check"><input type="checkbox" name="ativo" ${p.ativo !== false ? 'checked' : ''}> À venda</label>
        <label class="check"><input type="checkbox" name="destaque" ${p.destaque ? 'checked' : ''}> Destaque ⭐</label>
      </div>`;
  },
  salvarProdutoForm(id) {
    return d => {
      if (!d.nome.trim() || d.preco === '') { ui.toast('Preencha nome e preço'); return false; }
      d.preco = Number(d.preco);
      d.precoAntigo = d.precoAntigo === '' ? '' : Number(d.precoAntigo);
      d.estoque = d.estoque === '' ? '' : Number(d.estoque);
      DB.salvarProduto(id ? { ...d, id } : d);
      ui.toast(id ? 'Produto atualizado' : 'Produto criado!');
      render();
    };
  },
  novoProduto() { ui.modal('Novo produto', this.formProduto(), this.salvarProdutoForm()); },
  editarProduto(id) { ui.modal('Editar produto', this.formProduto(DB.produto(id)), this.salvarProdutoForm(id)); },
  duplicarProduto(id) {
    const { id: _, criadoEm, ...p } = DB.produto(id);
    DB.salvarProduto({ ...p, nome: p.nome + ' (cópia)' });
    ui.toast('Produto duplicado'); render();
  },
  removerProduto(id) {
    if (ui.confirmar('Excluir este produto?')) { DB.removerProduto(id); ui.toast('Produto excluído'); render(); }
  },

  mudarStatus(id, status) { DB.atualizarPedido(id, { status }); ui.toast(`Pedido ${id}: ${STATUS[status]}`); },
  removerPedido(id) {
    if (ui.confirmar(`Excluir o pedido ${id}?`)) { DB.removerPedido(id); render(); }
  },
  verPedido(id) {
    const p = DB.pedido(id), l = DB.loja(p.lojaId);
    ui.modal(`Pedido ${p.id}`, `
      <p><span class="badge ${p.status}">${STATUS[p.status]}</span> <small>${fmt.date(p.data)} · ${fmt.esc(l ? l.nome : '')}</small></p>
      <div class="fields">
        <div><label>Cliente</label>${fmt.esc(p.cliente.nome)}</div>
        <div><label>Nick / ID no jogo</label>${fmt.esc(p.cliente.nick || '—')}</div>
        <div><label>Contato</label>${fmt.esc(p.cliente.contato || '—')}</div>
        <div><label>Pagamento</label>${fmt.esc((p.pagamento || '').toUpperCase())}</div>
      </div>
      ${p.obs ? `<p><label>Observação</label>${fmt.esc(p.obs)}</p>` : ''}
      <table style="margin-top:12px"><tbody>
        ${p.itens.map(i => `<tr><td>${i.qtd}× ${fmt.esc(i.nome)}</td><td class="num">${fmt.money(i.preco * i.qtd)}</td></tr>`).join('')}
        <tr><td><b>Total</b></td><td class="num"><b>${fmt.money(p.total)}</b></td></tr>
      </tbody></table>`);
  },
  novoPedido() {
    const prods = DB.produtos().filter(p => p.ativo);
    if (!prods.length) return ui.toast('Cadastre produtos primeiro');
    ui.modal('Venda manual', `
      <div class="field"><label>Produto</label><select name="produtoId">
        ${prods.map(p => `<option value="${p.id}">${fmt.esc(DB.loja(p.lojaId)?.nome)} — ${fmt.esc(p.nome)} (${fmt.money(p.preco)})</option>`).join('')}</select></div>
      <div class="fields">
        <div class="field"><label>Quantidade</label><input name="qtd" type="number" min="1" value="1"></div>
        <div class="field"><label>Status</label><select name="status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === 'pago' ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Cliente *</label><input name="nome" required></div>
        <div class="field"><label>Nick / ID no jogo</label><input name="nick"></div>
        <div class="field"><label>Contato</label><input name="contato"></div>
        <div class="field"><label>Pagamento</label><select name="pagamento"><option value="pix">Pix</option><option value="cartao">Cartão</option><option value="outro">Outro</option></select></div>
      </div>`, d => {
      if (!d.nome.trim()) { ui.toast('Informe o cliente'); return false; }
      const p = DB.produto(d.produtoId), qtd = Math.max(1, Number(d.qtd) || 1);
      DB.criarPedido({
        lojaId: p.lojaId, cliente: { nome: d.nome, nick: d.nick, contato: d.contato },
        itens: [{ produtoId: p.id, nome: p.nome, preco: p.preco, qtd }],
        total: +(p.preco * qtd).toFixed(2), pagamento: d.pagamento, status: d.status,
      });
      ui.toast('Venda registrada'); render();
    });
  },
  exportarCSV() {
    const linhas = [['pedido', 'data', 'loja', 'cliente', 'nick', 'contato', 'itens', 'total', 'status']];
    DB.pedidos(ui.filtros.lojaId).forEach(p => linhas.push([
      p.id, p.data, DB.loja(p.lojaId)?.nome || '', p.cliente.nome, p.cliente.nick || '', p.cliente.contato || '',
      p.itens.map(i => `${i.qtd}x ${i.nome}`).join(' | '), p.total.toFixed(2).replace('.', ','), STATUS[p.status],
    ]));
    const csv = linhas.map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    baixar('﻿' + csv, 'pedidos.csv', 'text/csv');
  },

  exportar() { baixar(DB.exportar(), 'lojas.json', 'application/json'); },
  carregarDemo() { DB.demo(); ui.toast('Dados de exemplo carregados'); go('visao'); },
  limparTudo() {
    if (ui.confirmar('Tem certeza? Isso apaga TODOS os dados deste navegador.')) { DB.limpar(); ui.toast('Dados apagados'); go('visao'); }
  },
};

function baixar(conteudo, nome, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ======================= ROTEAMENTO =======================
function go(view) {
  ui.view = view;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  $('#sidebar').classList.remove('open');
  render();
}

function render() {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
  $('#view').innerHTML = (views[ui.view] || views.visao)();
  bindFiltros();
}

function bindFiltros() {
  const f = ui.filtros;
  const on = (sel, key, ev = 'change') => {
    const el = $(sel);
    if (el) el.addEventListener(ev, e => {
      f[key] = e.target.value;
      if (ev === 'input') {
        const pos = e.target.selectionStart;
        render();
        const n = $(sel); n.focus(); n.setSelectionRange(pos, pos);
      } else render();
    });
  };
  on('#pfLoja', 'lojaId');
  on('#pfCat', 'categoria');
  on('#pfStatus', 'status');
  on('#pfBusca', 'busca', 'input');
  const imp = $('#importFile');
  if (imp) imp.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { DB.importar(await file.text()); ui.toast('Dados importados!'); go('visao'); }
    catch (err) { ui.toast('Erro: ' + err.message); }
  };
}

$$('.nav-btn').forEach(b => (b.onclick = () => go(b.dataset.view)));
$('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');
window.addEventListener('storage', () => { DB.load(); render(); }); // pedidos feitos na vitrine em outra aba

DB.loadWithFallback().then(() => {
  const h = location.hash.slice(1);
  go(views[h] ? h : 'visao');
});
