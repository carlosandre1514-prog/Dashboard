// Vitrine pública: loja.html?loja=<slug>  (sem parâmetro = lista de lojas)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const shop = {
  loja: null,
  categoria: '',
  busca: '',
  cart: [],

  cartKey() { return 'cart_' + this.loja.id; },
  loadCart() {
    try { this.cart = JSON.parse(localStorage.getItem(this.cartKey())) || []; } catch (e) { this.cart = []; }
    this.cart = this.cart.filter(i => DB.produto(i.produtoId));
  },
  saveCart() {
    try { localStorage.setItem(this.cartKey(), JSON.stringify(this.cart)); } catch (e) { }
    this.renderCartCount();
  },
  total() {
    return this.cart.reduce((s, i) => s + DB.produto(i.produtoId).preco * i.qtd, 0);
  },
  disponivel(p) { return p.estoque === '' || p.estoque == null ? Infinity : Number(p.estoque); },

  add(id) {
    const p = DB.produto(id);
    const item = this.cart.find(i => i.produtoId === id);
    const atual = item ? item.qtd : 0;
    if (atual + 1 > this.disponivel(p)) return toast('Estoque insuficiente');
    if (item) item.qtd++; else this.cart.push({ produtoId: id, qtd: 1 });
    this.saveCart();
    toast(`${p.nome} adicionado ao carrinho`);
  },
  setQtd(id, qtd) {
    const p = DB.produto(id);
    qtd = Math.min(qtd, this.disponivel(p));
    if (qtd <= 0) this.cart = this.cart.filter(i => i.produtoId !== id);
    else this.cart.find(i => i.produtoId === id).qtd = qtd;
    this.saveCart();
    this.openCart();
  },

  // ---------- render ----------
  renderLista() {
    document.title = 'Lojas de jogos';
    const lojas = DB.lojas().filter(l => l.ativa !== false);
    $('#shop').innerHTML = `
      <header class="shop-header"><div class="inner">
        <div class="thumb"><span class="emoji">🎮</span></div>
        <div><h1>Lojas de jogos</h1><p class="muted">Moedas, skins e itens dos nossos jogos</p></div>
      </div></header>
      <main class="shop-main">
        ${lojas.length ? `<div class="grid cards">${lojas.map(l => `
          <a class="card store-card" style="--c:${fmt.esc(l.cor)};color:inherit" href="?loja=${encodeURIComponent(l.slug || l.id)}">
            <div class="head"><div class="thumb">${imgOrEmoji(l.logo)}</div>
              <div><h2 style="margin:0">${fmt.esc(l.nome)}</h2><small>${fmt.esc(l.jogo)}</small></div></div>
            <small>${fmt.esc(l.descricao)}</small>
            <span class="btn sm primary" style="align-self:flex-start;background:${fmt.esc(l.cor)};border-color:${fmt.esc(l.cor)}">Entrar na loja →</span>
          </a>`).join('')}</div>`
        : '<div class="card empty"><div class="big">🏪</div><p>Nenhuma loja publicada ainda.</p><a class="btn primary" href="index.html">Abrir painel</a></div>'}
      </main>`;
  },

  render() {
    const l = this.loja;
    document.title = l.nome;
    document.body.style.setProperty('--c', l.cor || '#8b5cf6');
    let prods = DB.produtos(l.id).filter(p => p.ativo !== false);
    const cats = [...new Set(prods.map(p => p.categoria))];
    if (this.categoria) prods = prods.filter(p => p.categoria === this.categoria);
    if (this.busca) prods = prods.filter(p => p.nome.toLowerCase().includes(this.busca.toLowerCase()));
    prods.sort((a, b) => (b.destaque ? 1 : 0) - (a.destaque ? 1 : 0) || a.preco - b.preco);

    $('#shop').innerHTML = `
      <header class="shop-header"><div class="inner">
        <div class="thumb">${imgOrEmoji(l.logo)}</div>
        <div>
          <h1>${fmt.esc(l.nome)}</h1>
          <p class="muted" style="margin:0">${fmt.esc(l.jogo ? l.jogo + ' · ' : '')}${fmt.esc(l.descricao)}</p>
          <div class="row" style="margin-top:10px">
            ${l.discord ? `<a class="btn sm" href="${fmt.esc(l.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}
            ${l.whatsapp ? `<a class="btn sm" href="https://wa.me/${l.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          </div>
        </div>
      </div></header>
      <nav class="shop-nav"><div class="inner">
        <div class="tabs">
          <button class="chip ${!this.categoria ? 'active' : ''}" data-cat="">Tudo</button>
          ${cats.map(c => `<button class="chip ${this.categoria === c ? 'active' : ''}" data-cat="${c}">${CATEGORIAS[c] || c}</button>`).join('')}
        </div>
        <input id="busca" placeholder="Buscar..." style="width:180px" value="${fmt.esc(this.busca)}">
        <button class="btn cart-btn" id="cartBtn">🛒 Carrinho <span class="cart-count" id="cartCount">0</span></button>
      </div></nav>
      <main class="shop-main">
        ${l.ativa === false ? '<div class="card" style="margin-bottom:16px;border-color:var(--warn)">⏸️ Esta loja está temporariamente pausada e não está aceitando pedidos.</div>' : ''}
        ${prods.length ? `<div class="products">${prods.map(p => this.card(p)).join('')}</div>`
        : '<div class="empty"><div class="big">🔍</div>Nenhum produto encontrado.</div>'}
      </main>
      <footer class="shop-footer">${fmt.esc(l.nome)} · <a href="loja.html">todas as lojas</a></footer>`;

    $$('.chip').forEach(c => (c.onclick = () => { this.categoria = c.dataset.cat; this.render(); }));
    $('#busca').oninput = e => {
      this.busca = e.target.value;
      const pos = e.target.selectionStart;
      this.render();
      $('#busca').focus(); $('#busca').setSelectionRange(pos, pos);
    };
    $('#cartBtn').onclick = () => this.openCart();
    $$('[data-add]').forEach(b => (b.onclick = () => this.add(b.dataset.add)));
    this.renderCartCount();
  },

  card(p) {
    const esgotado = this.disponivel(p) <= 0;
    const fechada = this.loja.ativa === false;
    const desconto = p.precoAntigo && p.precoAntigo > p.preco ? Math.round((1 - p.preco / p.precoAntigo) * 100) : 0;
    return `<div class="product">
      <div class="img">${imgOrEmoji(p.imagem)}
        ${desconto ? `<span class="tag">-${desconto}%</span>` : p.destaque ? '<span class="tag">⭐ Destaque</span>' : ''}</div>
      <div class="body">
        <small>${CATEGORIAS[p.categoria] || ''}</small>
        <b>${fmt.esc(p.nome)}</b>
        ${p.descricao ? `<small>${fmt.esc(p.descricao)}</small>` : ''}
        <div class="price">${fmt.money(p.preco)}${desconto ? `<span class="old">${fmt.money(p.precoAntigo)}</span>` : ''}</div>
        ${this.disponivel(p) !== Infinity && !esgotado && this.disponivel(p) <= 10 ? `<small style="color:var(--warn)">Restam ${p.estoque}</small>` : ''}
        <button class="btn" data-add="${p.id}" ${esgotado || fechada ? 'disabled' : ''}>${esgotado ? 'Esgotado' : 'Adicionar ao carrinho'}</button>
      </div></div>`;
  },

  renderCartCount() {
    const el = $('#cartCount');
    if (el) el.textContent = this.cart.reduce((s, i) => s + i.qtd, 0);
  },

  closeDrawer() { $('#modalRoot').innerHTML = ''; },

  openCart() {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-bg" style="place-items:stretch end;padding:0" id="bg"></div>
      <aside class="drawer">
        <header class="row between"><h2 style="margin:0">🛒 Carrinho</h2><button class="btn ghost sm" id="x">✕</button></header>
        <div class="items">${this.cart.length ? this.cart.map(i => {
          const p = DB.produto(i.produtoId);
          return `<div class="cart-item">
            <div class="thumb">${imgOrEmoji(p.imagem)}</div>
            <div class="info"><b>${fmt.esc(p.nome)}</b><br><small>${fmt.money(p.preco)}</small></div>
            <div class="qty"><button data-q="${p.id}" data-d="-1">−</button><span style="min-width:22px;text-align:center">${i.qtd}</span><button data-q="${p.id}" data-d="1">+</button></div>
          </div>`;
        }).join('') : '<div class="empty">Seu carrinho está vazio.</div>'}</div>
        <footer>
          <div class="row between" style="margin-bottom:12px"><span>Total</span><b style="font-size:1.3rem">${fmt.money(this.total())}</b></div>
          <button class="btn primary" style="width:100%;justify-content:center;background:var(--c);border-color:var(--c)" id="checkout" ${this.cart.length ? '' : 'disabled'}>Finalizar compra</button>
        </footer>
      </aside>`;
    $('#bg').onclick = $('#x').onclick = () => this.closeDrawer();
    $$('[data-q]', root).forEach(b => (b.onclick = () => {
      const it = this.cart.find(i => i.produtoId === b.dataset.q);
      this.setQtd(b.dataset.q, it.qtd + Number(b.dataset.d));
    }));
    const c = $('#checkout');
    if (c) c.onclick = () => this.checkout();
  },

  checkout() {
    const l = this.loja;
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-bg"><form class="modal">
        <div class="row between"><h2>Finalizar compra</h2><button type="button" class="btn ghost sm" id="x">✕</button></div>
        <div class="field"><label>Seu nome *</label><input name="nome" required></div>
        <div class="field"><label>Nick / ID da conta no jogo *</label><input name="nick" required placeholder="Para onde enviaremos os itens"></div>
        <div class="field"><label>WhatsApp, e-mail ou Discord *</label><input name="contato" required></div>
        <div class="field"><label>Observação</label><textarea name="obs" rows="2"></textarea></div>
        <div class="row between"><span>Total</span><b style="font-size:1.3rem">${fmt.money(this.total())}</b></div>
        <div class="actions"><button type="submit" class="btn primary" style="background:var(--c);border-color:var(--c)">Confirmar pedido</button></div>
      </form></div>`;
    $('#x').onclick = () => this.closeDrawer();
    $('form', root).onsubmit = e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target).entries());
      if (!d.nome.trim() || !d.nick.trim() || !d.contato.trim()) return toast('Preencha os campos obrigatórios');
      DB.load(); // recarrega estoque atualizado
      for (const i of this.cart) {
        const p = DB.produto(i.produtoId);
        if (!p || i.qtd > this.disponivel(p)) return toast(`Estoque insuficiente: ${p ? p.nome : 'produto removido'}`);
      }
      const itens = this.cart.map(i => {
        const p = DB.produto(i.produtoId);
        return { produtoId: p.id, nome: p.nome, preco: p.preco, qtd: i.qtd };
      });
      const pedido = DB.criarPedido({
        lojaId: l.id, cliente: { nome: d.nome, nick: d.nick, contato: d.contato }, obs: d.obs,
        itens, total: +itens.reduce((s, i) => s + i.preco * i.qtd, 0).toFixed(2), pagamento: 'pix',
      });
      this.cart = [];
      this.saveCart();
      this.sucesso(pedido);
    };
  },

  sucesso(p) {
    const l = this.loja;
    const msg = `Olá! Fiz o pedido *${p.id}* na ${l.nome}:\n` +
      p.itens.map(i => `• ${i.qtd}x ${i.nome} — ${fmt.money(i.preco * i.qtd)}`).join('\n') +
      `\n*Total: ${fmt.money(p.total)}*\nNick: ${p.cliente.nick}\nSegue o comprovante do Pix.`;
    $('#modalRoot').innerHTML = `
      <div class="modal-bg"><div class="modal" style="text-align:center">
        <div style="font-size:52px">✅</div>
        <h2>Pedido ${p.id} criado!</h2>
        <p class="muted">Total: <b style="color:var(--text)">${fmt.money(p.total)}</b></p>
        ${l.pix ? `<p>Pague via Pix usando a chave:</p>
          <div class="pix-box" id="pix">${fmt.esc(l.pix)}</div>
          <button class="btn sm" style="margin-top:8px" id="copy">Copiar chave Pix</button>` : ''}
        <p class="muted">Depois envie o comprovante para receber seus itens.</p>
        <div class="actions" style="justify-content:center">
          ${l.whatsapp ? `<a class="btn primary" style="background:#22c55e;border-color:#22c55e" target="_blank" rel="noopener"
            href="https://wa.me/${l.whatsapp}?text=${encodeURIComponent(msg)}">Enviar no WhatsApp</a>` : ''}
          <button class="btn" id="ok">Voltar à loja</button>
        </div>
      </div></div>`;
    $('#ok').onclick = () => { this.closeDrawer(); this.render(); };
    const cp = $('#copy');
    if (cp) cp.onclick = () => navigator.clipboard?.writeText(l.pix).then(() => toast('Chave copiada!'), () => toast('Copie manualmente'));
  },
};

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

DB.loadWithFallback().then(() => {
  const q = new URLSearchParams(location.search).get('loja');
  if (!q) return shop.renderLista();
  shop.loja = DB.lojas().find(l => l.slug === q || l.id === q);
  if (!shop.loja) {
    $('#shop').innerHTML = '<div class="empty" style="padding-top:120px"><div class="big">😕</div><h2>Loja não encontrada</h2><a href="loja.html">Ver todas as lojas</a></div>';
    return;
  }
  shop.loadCart();
  shop.render();
});
