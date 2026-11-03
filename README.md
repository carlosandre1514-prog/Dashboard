# NEXUS — hub dos seus jogos

Plataforma completa para um desenvolvedor de jogos independente:

- **Site público** com catálogo dos seus jogos, página de cada jogo com **download** e **loja oficial**
  (moedas, skins, itens, passes), conta do jogador e pagamento via **Pix com QR Code**.
- **Painel de controle** (`/admin`) com visual técnico/HUD: receita, moedas vendidas, ticket médio,
  downloads, cadastros, jogadores ativos, funil de conversão, horário de compra, ranking de produtos,
  feed em tempo real e muito mais, com gráficos de linha, área, colunas, colunas empilhadas, rosca,
  barras, mapa de calor e funil.
- **API para os jogos** (`/api/v1`): o jogo registra jogadores, envia telemetria, informa compras feitas
  dentro dele e busca as compras feitas no site para entregar os itens automaticamente.

Sem dependências externas: só **Node.js 22.13+** (usa o SQLite embutido no Node).

## Rodando

```bash
npm start            # http://localhost:3000  (site)  e  http://localhost:3000/admin  (painel)
npm run seed         # opcional: gera 3 jogos de demonstração com 120 dias de vendas e telemetria
```

No primeiro acesso ao `/admin` você cria a conta de administrador. Os dados ficam em `data/nexus.db`.

Variáveis de ambiente: `PORT` (padrão 3000), `DATA_DIR` (pasta do banco), `TZ_OFFSET_MIN` (fuso dos
relatórios em minutos, padrão `-180` = Brasília).

## Painel

| Página | O que mostra |
|---|---|
| Centro de comando | Totais históricos, 8 indicadores com variação vs. período anterior e mini-gráfico, desempenho (receita/pedidos/moedas em linha, área ou colunas por canal), receita por jogo, tráfego, funil, mapa de calor de horário de compra, atividade ao vivo, produtos mais vendidos, canal e forma de pagamento |
| Vendas & receita | Receita bruta, estornos, líquida, moedas vendidas por jogo (na moeda de cada jogo), itens, pendências, receita por jogo ao longo do tempo, por tipo de produto, plataforma, pagamento, status e ranking completo de produtos |
| Audiência | Visualizações, visitantes únicos, downloads, instalações, cadastros, jogadores ativos, sessões, países e comparativo entre jogos |
| Ao vivo | Eventos chegando em tempo real (stream SSE) |
| Jogos / Produtos | Cadastro dos jogos (página pública, link de download, plataformas, moeda) e dos produtos (SKU, preço, promoção, moedas entregues, estoque) |
| Pedidos / Jogadores | Todos os pedidos com filtros, detalhes, linha do tempo e ações (confirmar pagamento, entregar, estornar), exportação CSV; base de jogadores |
| Integração · API | Chave de API de cada jogo, endpoints, exemplos (cURL, Unity, Godot, JS) e console de teste |
| Configurações | Nome da loja, chave Pix, webhook de pagamento, dados de demonstração |

Atalho: **Ctrl K** abre a paleta de comandos. Todos os filtros de período (7D, 30D, 90D, 12M ou
personalizado) e de jogo valem para a página inteira.

## Conectando um jogo

1. Cadastre o jogo no painel e copie a chave em **Integração · API**.
2. Use o SDK pronto: `sdk/unity/NexusClient.cs` (Unity) ou `sdk/godot/nexus.gd` (Godot 4).
   Qualquer outra engine funciona com HTTP + JSON.

Fluxos:

- **Compra dentro do jogo:** depois que a loja da plataforma (Google Play, App Store, Steam) confirmar o
  pagamento, o jogo chama `POST /api/v1/purchases` com `status: "paid"` e o `external_ref` do recibo
  (evita duplicidade). A venda entra no painel na hora.
- **Compra no site:** o jogador escolhe os itens na página do jogo, informa o ID de jogador e paga com Pix.
  Quando o pagamento é confirmado (manualmente no painel ou pelo webhook), o jogo encontra a compra em
  `GET /api/v1/deliveries?external_id=...`, credita os itens e confirma com `POST /api/v1/deliveries/:code/ack`.
- **Telemetria:** `POST /api/v1/events` com `session_start`, `install` ou `download`.

## Pagamentos

O site gera o **Pix copia-e-cola e o QR Code** (padrão do Banco Central) com o valor e o código do pedido,
usando a chave Pix configurada. Para confirmar pagamentos automaticamente, configure no seu provedor
(Mercado Pago, Asaas, PagSeguro…) ou numa automação uma chamada para:

```
POST /api/webhooks/payment
X-Webhook-Secret: <segredo definido em Configurações>
{"code": "NX-XXXX-XXXX", "status": "paid"}
```

Sem webhook, você confirma cada pagamento no painel (Pedidos → abrir o pedido → Confirmar pagamento).

## Publicando

Precisa de um servidor Node com disco persistente para o arquivo do banco (VPS, Railway, Render, Fly.io
com volume). Coloque atrás de HTTPS (Nginx/Caddy ou o próprio provedor). Faça backup de `data/nexus.db`.

## Segurança — leia antes de lançar

- A chave de API vai dentro do jogo e pode ser extraída do executável. Com ela alguém consegue registrar
  compras falsas (que só poluem as estatísticas) ou confirmar entregas de outro jogador. Para jogos com
  muito dinheiro envolvido, faça as chamadas por um servidor seu e valide os recibos das lojas.
- Confirme pagamentos Pix só depois de ver o dinheiro na conta (ou pelo webhook do provedor).
- Troque a chave do jogo em **Integração · API** se ela vazar.
