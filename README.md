# 🎮 GameStore Dashboard

Painel para gerenciar suas lojas de jogos e vender **moedas, skins, itens, passes VIP e contas**,
com uma vitrine pública para cada loja.

Funciona 100% no navegador, sem servidor e sem instalar nada.

## Como usar

1. Abra o `index.html` no navegador (ou publique no GitHub Pages, veja abaixo).
2. Clique em **Carregar dados de exemplo** para ver como funciona, ou em **+ Criar loja**.
3. Cadastre produtos em **Produtos** (preço, promoção, estoque, imagem por emoji ou URL, destaque).
4. Em **Minhas lojas**, clique em **Abrir loja ↗** para ver a vitrine que o cliente vê.

## Funcionalidades

**Painel (`index.html`)**
- Visão geral: receita, ticket médio, pedidos pendentes, itens a entregar, gráfico de receita por dia,
  produtos mais vendidos e receita por loja, com filtros de loja e período
- Várias lojas, cada uma com nome, jogo, logo, cor do tema, endereço (slug), WhatsApp, chave Pix e Discord
- Produtos por categoria (Moedas, Skins, Itens, Passes/VIP, Contas, Outros), com estoque e preço promocional
- Pedidos: muda status (Pendente → Pago → Entregue / Cancelado), vê detalhes, registra venda manual, exporta CSV
- Backup: exportar/importar JSON

**Vitrine (`loja.html?loja=<slug>`)**
- Página da loja com a cor e o logo dela, filtro por categoria e busca
- Carrinho, checkout com nome, nick/ID no jogo e contato
- Depois do pedido, mostra a chave Pix e um botão que envia o pedido pronto no WhatsApp
- `loja.html` sem parâmetro lista todas as lojas ativas

## Publicar no GitHub Pages

1. No painel, vá em **Configurações → Exportar JSON**.
2. Salve o arquivo como `data/lojas.json` neste repositório e faça commit.
3. No GitHub: **Settings → Pages → Deploy from a branch** e escolha o branch.
4. Suas lojas ficam em `https://<seu-usuario>.github.io/<repo>/loja.html?loja=<slug>`.

## Limitações importantes

- Os dados ficam no `localStorage` do navegador. Pedidos feitos pelos clientes **em outros aparelhos não
  chegam automaticamente ao painel**: eles chegam pelo WhatsApp. Para pedidos e pagamentos automáticos
  é preciso um backend (ex.: Firebase/Supabase) e um gateway de pagamento (ex.: Mercado Pago).
- O painel não tem login. Quem abrir o `index.html` publicado vê um painel vazio (os dados são do navegador
  de cada pessoa), mas não deixe dados sensíveis no `data/lojas.json`, porque ele é público.
- Venda de itens de jogos de terceiros pode violar os termos desses jogos. Use para os seus próprios jogos.
