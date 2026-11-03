# NEXUS — hub dos seus jogos

- **Site público:** catálogo de jogos com download, **Mercado** (moedas, skins, itens e passes de todos os
  jogos, com filtros), página de cada jogo, carrinho e pagamento **Pix com QR Code**.
- **Login e cadastro com Firebase** (e-mail/senha ou Google). Uma conta para tudo:
  - e-mail listado como administrador → vê o **painel** (`/admin`);
  - qualquer outra conta → vê só a **loja e os jogos**.
- **Painel de controle:** vendas, receita, moedas vendidas, quem comprou e quanto, **verificação de cada
  pagamento**, antifraude, audiência, telemetria ao vivo, jogos, produtos, pedidos e jogadores.
- **API para os jogos:** o jogo registra compras feitas dentro dele e entrega as compras feitas no site.

Só precisa do **Node.js 22.13+**. Não há dependências para instalar.

## Primeiros passos

```bash
cp .env.example .env      # coloque seu e-mail em ADMIN_EMAILS e gere um APP_SECRET
npm start                 # site: http://localhost:3000   painel: http://localhost:3000/admin
npm run seed              # opcional: 3 jogos de demonstração com 120 dias de vendas
npm test                  # 21 testes de segurança e pagamento
```

### 1. Firebase (login)

O projeto já vem ligado ao seu Firebase `dashboard-6fa1e`. No [console do Firebase](https://console.firebase.google.com):

1. **Authentication → Sign-in method:** ative **E-mail/senha** e **Google**.
2. **Authentication → Settings → Authorized domains:** adicione o domínio do seu site (o `localhost` já vem liberado).
3. **Google Cloud → APIs e serviços → Credenciais:** restrinja a chave de API ao domínio do seu site (HTTP referrer).

A chave do Firebase no código é pública por natureza: ela identifica o projeto, mas não dá acesso a nada.
Quem decide se alguém é administrador é o **servidor**. Ele confere a assinatura criptográfica do token do
Firebase com os certificados do Google.

### 2. Administradores

- Defina `ADMIN_EMAILS=seu-email@gmail.com` no `.env` (o dono). Entre pelo site com esse e-mail
  **confirmado**, ou pelo Google, e abra `/admin`.
- O dono pode adicionar outros administradores em **Configurações → Administradores**.
- Ative a **verificação em duas etapas** em **Segurança**. Ela vale para qualquer app autenticador.

### 3. Recebimento e verificação de pagamentos

Em **Configurações → Recebimento e verificação**, escolha uma das opções:

| Modo | Como o pagamento é comprovado |
|---|---|
| **Mercado Pago (recomendado)** | O Pix é gerado pelo Mercado Pago. Quando o cliente paga, o servidor **consulta o pagamento direto na API** com o seu token. Ele confere o valor exato, o código do pedido e a moeda antes de liberar. Um webhook com assinatura inválida é recusado. Uma conciliação automática roda a cada minuto, caso algum webhook se perca. |
| **Pix manual** | Pix estático com a sua chave. Você confere o extrato e confirma o pedido informando o **ID E2E** do comprovante e o valor. O sistema recusa um comprovante já usado ou um valor diferente, e pede que você confirme sua identidade. |

Para o Mercado Pago:
1. Pegue o **Access Token de produção** em *Suas integrações → Credenciais*.
2. Crie um webhook do evento **Pagamentos** apontando para `https://SEU-SITE/api/webhooks/mercadopago`.
3. Copie a **assinatura secreta** do webhook para o painel.

A tela **Pagamentos** mostra, para cada pedido:
- o comprador, o pagador (nome e CPF mascarado), o valor esperado e o valor recebido;
- a comprovação: verificado no banco, conferido à mão, loja do jogo (assinado), ou só informado pelo jogo;
- o risco e o histórico completo do pedido.

## Segurança

| Camada | O que faz |
|---|---|
| Login | Firebase Authentication. O token é verificado no servidor (assinatura RS256, projeto, emissor, validade). O painel exige e-mail **confirmado** e presente na lista de administradores. |
| 2FA | Código de app autenticador (TOTP), com proteção contra reuso de código e 8 códigos de recuperação. |
| Ações sensíveis | Confirmar pagamento, estornar, liberar pedido retido, mudar dados de pagamento, trocar chaves, gerenciar administradores e excluir jogo pedem **novo login de menos de 5 minutos**, mais o código 2FA se estiver ativo. |
| Sessões | Cookies `HttpOnly`, `SameSite=Strict` no painel e `Secure` em HTTPS. Só o hash do token fica salvo. O painel expira após 30 min parado e no máximo 12 h. Dá para encerrar as outras sessões. |
| CSRF e cabeçalhos | Toda ação exige a mesma origem e um cabeçalho próprio. A política de conteúdo (CSP) é estrita, sem scripts de terceiros fora do login Google. Também: HSTS, `X-Frame-Options`, `nosniff` e Permissions-Policy. |
| Força bruta e robôs | Limite de requisições por IP e por chave de API, bloqueio progressivo da conta após falhas de login e **bloqueio automático do IP** que insiste. |
| Antifraude | Pontuação de risco por pedido: valor alto, conta nova, muitos pedidos, várias contas no mesmo IP, ID de jogo de outra conta e histórico de estorno. A partir de 60 pontos o pedido fica **retido**, e o jogo não recebe os itens até um administrador liberar. |
| Pagamento | O preço é sempre calculado no servidor. O status vem da API do provedor, nunca do navegador. Valor e pedido são conferidos. O Pix expira em 30 min e devolve o estoque. Contestações (chargeback) e estornos são detectados. |
| API dos jogos | Chave por jogo e **assinatura HMAC opcional ou obrigatória**, com timestamp e bloqueio de requisição repetida (replay). Compras assinadas e não assinadas aparecem separadas nos relatórios. |
| Dados | Tokens e segredos criptografados (AES-256-GCM) com a `APP_SECRET`, CPF guardado mascarado, links `javascript:` bloqueados e CSV protegido contra injeção de fórmula. |
| Auditoria | Cada login, falha, confirmação, estorno e mudança de configuração é registrado numa **cadeia de hash**: se alguém alterar o banco, o painel mostra exatamente onde. |

### Publicar de graça no Render
O plano gratuito do Render apaga o disco sempre que o serviço dorme (15 min sem visitas) ou é atualizado.
Por isso o servidor salva o banco **criptografado no Firestore do seu Firebase** (grátis no plano Spark) e o
restaura sozinho ao ligar. Pedidos e pagamentos são salvos em segundos, e o resto a cada 5 minutos.

1. **Firestore:** no console do Firebase → *Firestore Database* → *Criar banco de dados* (modo produção).
   Em *Regras*, deixe tudo bloqueado (só o servidor acessa):
   `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }`
2. **Conta de serviço:** Firebase → ⚙ *Configurações do projeto* → *Contas de serviço* → *Gerar nova chave privada*.
   Baixa um arquivo `.json`. **Esse arquivo dá acesso total ao projeto: não envie ao GitHub nem a ninguém.**
3. **Render:** *New → Blueprint* → escolha este repositório. Preencha:
   - `ADMIN_EMAILS` = seu e-mail;
   - `FIREBASE_SERVICE_ACCOUNT` = o conteúdo inteiro do `.json`.
4. Depois do deploy, adicione `seu-app.onrender.com` em Firebase → Authentication → Settings → *Authorized domains*.
5. No painel → *Configurações* → URL pública = `https://seu-app.onrender.com`. Em *Segurança*, confira se
   "Backup criptografado na nuvem" está verde.

Limites do gratuito:
- Depois de 15 min sem visitas o site "dorme", e a primeira visita leva cerca de 1 minuto para abrir.
  Os webhooks do Mercado Pago são reenviados e acordam o servidor.
- Uma queda brusca pode perder no máximo os últimos segundos de alterações. Pagamentos do Mercado Pago
  são reconferidos na API ao voltar.
- Quando o movimento crescer, mude `plan: free` para `starter` com um disco (o backup pode continuar ligado).

### Em produção
- Rode atrás de HTTPS (Caddy, Nginx ou Cloudflare) com `TRUST_PROXY=1`, `FORCE_HTTPS=1` e `NODE_ENV=production`.
- Defina `APP_SECRET` fora do servidor de arquivos e faça backup de `data/nexus.db`.
- Ative a assinatura obrigatória dos jogos e, se possível, faça as chamadas de compra por um servidor seu.
  Uma chave embutida no jogo pode ser extraída do executável.

Nenhum sistema é 100% invulnerável. Antes de movimentar valores altos, contrate um teste de invasão
(pentest) independente e mantenha o Node.js sempre atualizado.

## Conectando um jogo

Use `sdk/unity/NexusClient.cs` (Unity) ou `sdk/godot/nexus.gd` (Godot 4). A tela **Integração · API**
do painel tem a chave de cada jogo, os endpoints, exemplos de código e um console de teste.

- **Compra dentro do jogo:** depois que a loja da plataforma confirmar, chame `POST /api/v1/purchases`
  com `status: "paid"` e o `external_ref` do recibo.
- **Compra no site:** o jogo chama `GET /api/v1/deliveries?external_id=...` e credita os itens. Depois
  confirma com `POST /api/v1/deliveries/:code/ack`. Só aparecem pedidos **pagos, verificados e fora de análise**.
- **Telemetria:** `POST /api/v1/events` com `session_start`, `install` ou `download`.
