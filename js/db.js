// Camada de dados: tudo salvo no navegador (localStorage).
// Pode exportar/importar em JSON e publicar em data/lojas.json.
const DB_KEY = 'gamestore_dashboard_v1';

const DB = {
  state: null,

  empty() {
    return { lojas: [], produtos: [], pedidos: [], config: { moeda: 'BRL' } };
  },

  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      this.state = raw ? JSON.parse(raw) : null;
    } catch (e) { this.state = null; }
    if (!this.state) this.state = this.empty();
    for (const k of ['lojas', 'produtos', 'pedidos']) this.state[k] ||= [];
    this.state.config ||= { moeda: 'BRL' };
    return this.state;
  },

  async loadWithFallback() {
    this.load();
    if (this.state.lojas.length === 0) {
      try {
        const r = await fetch('data/lojas.json', { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.lojas) && data.lojas.length) {
            this.state = { ...this.empty(), ...data };
            this.save();
          }
        }
      } catch (e) { /* sem arquivo publicado */ }
    }
    return this.state;
  },

  save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(this.state)); }
    catch (e) { alert('Não foi possível salvar (armazenamento cheio?). Use imagens por URL em vez de upload.'); }
  },

  id(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  // ---------- Lojas ----------
  lojas() { return this.state.lojas; },
  loja(id) { return this.state.lojas.find(l => l.id === id); },
  salvarLoja(loja) {
    if (loja.id) {
      const i = this.state.lojas.findIndex(l => l.id === loja.id);
      this.state.lojas[i] = { ...this.state.lojas[i], ...loja };
    } else {
      loja.id = this.id('loja');
      loja.criadoEm = new Date().toISOString();
      this.state.lojas.push(loja);
    }
    this.save();
    return loja;
  },
  removerLoja(id) {
    this.state.lojas = this.state.lojas.filter(l => l.id !== id);
    this.state.produtos = this.state.produtos.filter(p => p.lojaId !== id);
    this.save();
  },

  // ---------- Produtos ----------
  produtos(lojaId) {
    return lojaId ? this.state.produtos.filter(p => p.lojaId === lojaId) : this.state.produtos;
  },
  produto(id) { return this.state.produtos.find(p => p.id === id); },
  salvarProduto(p) {
    if (p.id) {
      const i = this.state.produtos.findIndex(x => x.id === p.id);
      this.state.produtos[i] = { ...this.state.produtos[i], ...p };
    } else {
      p.id = this.id('prod');
      p.criadoEm = new Date().toISOString();
      this.state.produtos.push(p);
    }
    this.save();
    return p;
  },
  removerProduto(id) {
    this.state.produtos = this.state.produtos.filter(p => p.id !== id);
    this.save();
  },

  // ---------- Pedidos ----------
  pedidos(lojaId) {
    const all = [...this.state.pedidos].sort((a, b) => b.data.localeCompare(a.data));
    return lojaId ? all.filter(p => p.lojaId === lojaId) : all;
  },
  pedido(id) { return this.state.pedidos.find(p => p.id === id); },
  criarPedido(pedido) {
    pedido.id = 'PED-' + Date.now().toString(36).toUpperCase().slice(-6);
    pedido.data = new Date().toISOString();
    pedido.status ||= 'pendente';
    this.state.pedidos.push(pedido);
    // baixa de estoque
    for (const it of pedido.itens) {
      const p = this.produto(it.produtoId);
      if (p && p.estoque !== '' && p.estoque != null) p.estoque = Math.max(0, Number(p.estoque) - it.qtd);
    }
    this.save();
    return pedido;
  },
  atualizarPedido(id, campos) {
    const p = this.pedido(id);
    if (p) Object.assign(p, campos);
    this.save();
  },
  removerPedido(id) {
    this.state.pedidos = this.state.pedidos.filter(p => p.id !== id);
    this.save();
  },

  // ---------- Backup ----------
  exportar() { return JSON.stringify(this.state, null, 2); },
  importar(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.lojas)) throw new Error('Arquivo inválido');
    this.state = { ...this.empty(), ...data };
    this.save();
  },
  limpar() { this.state = this.empty(); this.save(); },

  demo() {
    const l1 = this.salvarLoja({
      nome: 'Dragon Coins', slug: 'dragon-coins', jogo: 'Reino de Dragões',
      descricao: 'Moedas, gemas e skins lendárias com entrega rápida.',
      cor: '#8b5cf6', logo: '🐉', whatsapp: '5511999999999', pix: 'loja@exemplo.com', ativa: true,
    });
    const l2 = this.salvarLoja({
      nome: 'Pixel Arena Shop', slug: 'pixel-arena', jogo: 'Pixel Arena',
      descricao: 'Skins de armas, passes de temporada e créditos.',
      cor: '#06b6d4', logo: '🎯', whatsapp: '5511988888888', pix: '11988888888', ativa: true,
    });
    const prods = [
      [l1, 'Pacote 1.000 Moedas', 'moedas', 9.9, 999, '🪙'],
      [l1, 'Pacote 5.000 Moedas', 'moedas', 39.9, 999, '💰'],
      [l1, 'Skin Dragão de Fogo', 'skins', 24.9, 50, '🔥'],
      [l1, 'Passe VIP 30 dias', 'passes', 19.9, '', '👑'],
      [l2, '500 Créditos', 'moedas', 14.9, 999, '💎'],
      [l2, 'Skin Rifle Neon', 'skins', 29.9, 30, '🔫'],
      [l2, 'Conta Nível 50', 'contas', 79.9, 3, '🎮'],
    ];
    const ids = prods.map(([l, nome, categoria, preco, estoque, imagem]) =>
      this.salvarProduto({ lojaId: l.id, nome, categoria, preco, estoque, imagem, descricao: '', ativo: true, destaque: preco > 20 }));
    const clientes = ['Lucas', 'Ana', 'Pedro', 'Julia', 'Rafa', 'Bia', 'Gui', 'Carla'];
    const status = ['entregue', 'entregue', 'pago', 'pendente', 'entregue', 'cancelado'];
    for (let d = 0; d < 20; d++) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const p = ids[Math.floor(Math.random() * ids.length)];
        const qtd = 1 + Math.floor(Math.random() * 2);
        const date = new Date(Date.now() - d * 86400000 - Math.random() * 3600000 * 10);
        this.state.pedidos.push({
          id: 'PED-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          lojaId: p.lojaId, data: date.toISOString(),
          cliente: { nome: clientes[Math.floor(Math.random() * clientes.length)], contato: '', nick: 'player' + Math.floor(Math.random() * 999) },
          itens: [{ produtoId: p.id, nome: p.nome, preco: p.preco, qtd }],
          total: +(p.preco * qtd).toFixed(2),
          pagamento: 'pix', status: status[Math.floor(Math.random() * status.length)],
        });
      }
    }
    this.save();
  },
};

const fmt = {
  money(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); },
  date(iso) { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};

const CATEGORIAS = {
  moedas: 'Moedas', skins: 'Skins', itens: 'Itens', passes: 'Passes / VIP', contas: 'Contas', outros: 'Outros',
};
const STATUS = {
  pendente: 'Pendente', pago: 'Pago', entregue: 'Entregue', cancelado: 'Cancelado',
};

// Renderiza imagem do produto/loja: emoji ou URL
function imgOrEmoji(v, cls = '') {
  if (!v) return `<span class="emoji ${cls}">🎮</span>`;
  if (/^(https?:|data:)/.test(v)) return `<img class="${cls}" src="${fmt.esc(v)}" alt="">`;
  return `<span class="emoji ${cls}">${fmt.esc(v)}</span>`;
}
