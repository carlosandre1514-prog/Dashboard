# Favela Stricker ↔ loja NEXUS

Liga a **Loja de moedas** do jogo ao site de vendas. O jogador toca no preço, paga o Pix no site (com o ID dele já
preenchido) e as moedas chegam sozinhas no jogo. Funciona no APK e na versão de navegador.

```
jogo (telas web/)  ── token de login do Firebase do jogo ──▶  servidor do jogo (servidor/loja-nexus.js)
                                                                   │  chave da API + assinatura (secretas)
                                                                   ▼
                                                     site NEXUS /api/v1 (entregas verificadas)
```

A chave da API fica **só no servidor do jogo**. O servidor confere o login do jogador antes de qualquer coisa,
então ninguém pega nem confirma a compra de outro jogador. Testado em `tests/loja-favela.test.js` no repositório do site.

---

## 1. Painel do site (nexus-p70i.onrender.com/admin)

1. **Jogos → Novo jogo**: nome `Favela Stricker`, endereço `favela-stricker`, moeda `Moedas`, plataforma Android.
2. **Produtos** — os mesmos pacotes da tela do jogo (`PACOTES` em `web/conta.js`). Em **Moedas**, ponha o total com bônus:

| SKU | Nome | Preço | Moedas |
|---|---|---|---|
| `MOEDAS_100` | 100 moedas | R$ 4,99 | 100 |
| `MOEDAS_310` | 310 moedas | R$ 14,99 | 320 |
| `MOEDAS_520` | 520 moedas | R$ 24,99 | 540 |
| `MOEDAS_1060` | 1.060 moedas | R$ 49,99 | 1.120 |
| `MOEDAS_2180` | 2.180 moedas | R$ 99,99 | 2.360 |
| `MOEDAS_5600` | 5.600 moedas | R$ 249,99 | 6.200 |

   Também dá para vender **roupas** (`SKIN_<key>`, ex.: `SKIN_CHOQUE`) e **skins de arma**
   (`SKINARMA_<arma>_<key>`, ex.: `SKINARMA_TT33_CRIMSON_FORGE`). O jogo confere com `ROUPAS`/`SKINS_ARMA`.
3. **Integração · API** → jogo Favela Stricker → copie a **chave**. Recomendado: **Criar segredo** e
   **Exigir assinatura**.

## 2. Servidor do jogo

1. Copie `loja-nexus.js` para `servidor/loja-nexus.js`.
2. Em `servidor/server.js`:

```js
const loja = require('./loja-nexus');
// …
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await loja.tratar(req, res, url)) return;          // ← primeira linha dentro do handler
  if (url.pathname === '/saude') { /* … como já está … */ }
```

3. No Render do **jogo** → Environment:

```
NEXUS_URL=https://nexus-p70i.onrender.com
NEXUS_API_KEY=nx_live_…              (do painel)
NEXUS_SIGNING_SECRET=nxs_…           (se criou o segredo)
FIREBASE_PROJECT_ID=navegador-f06a8
```

## 3. Telas do jogo (`web/`)

### 3.1 Novo arquivo `web/loja_nexus.js`, incluído no `index.html` **depois de** `jogo.js`

```js
// Loja NEXUS: compra de moedas no site + entrega automática no jogo
const LOJA = { site: 'https://nexus-p70i.onrender.com', jogo: 'favela-stricker' };
const SKU_PACOTES = ['MOEDAS_100', 'MOEDAS_310', 'MOEDAS_520', 'MOEDAS_1060', 'MOEDAS_2180', 'MOEDAS_5600'];

async function lojaApi(metodo, rota, corpo) {
  if (!fb || !fb.uid || fb.anonimo) return null;               // convidado não compra
  const t = await fb.tokenValido();
  const r = await fetch(SERVIDOR + '/api/loja/' + rota, {
    method: metodo, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return r.ok ? r.json() : null;
}

// abre o pagamento do pacote no navegador, com o ID do jogador já preenchido
function comprarNoSite(i) {
  if (!fb || fb.anonimo) return janela('Entre na sua conta', 'Para comprar moedas, entre com e-mail e senha (convidado não pode comprar).');
  const url = `${LOJA.site}/jogo/${LOJA.jogo}?id=${encodeURIComponent(fb.uid)}&sku=${SKU_PACOTES[i]}`;
  if (window.Nativo && Nativo.abrirLink) Nativo.abrirLink(url); else window.open(url, '_blank');
  janela('Pagamento aberto no navegador', 'Pague o Pix no site e volte ao jogo: as moedas entram sozinhas em alguns segundos.');
}

// entrega: credita e grava a conta ANTES de confirmar; o código do pedido fica na conta (nunca credita 2 vezes)
let entregando = false;
async function receberComprasDoSite() {
  if (entregando) return; entregando = true;
  try {
    const lista = await lojaApi('GET', 'entregas');
    for (const o of lista || []) {
      const marca = 'pedido:' + o.code;
      if (!conta.itens().has(marca)) {
        let moedas = 0;
        for (const it of o.items) {
          const sku = String(it.sku).toUpperCase();
          const roupa = ROUPAS.find((r) => 'SKIN_' + r.key.toUpperCase() === sku);
          const sa = SKINS_ARMA.find((s) => `SKINARMA_${s.arma}_${s.key}`.toUpperCase() === sku);
          if (roupa) conta.ganhar('skin:' + roupa.key);
          else if (sa) conta.ganhar(`skin_arma:${sa.arma}:${sa.key}`);
          else moedas += (it.coins || 0) * (it.qty || 1);
        }
        if (moedas) conta.moedas = conta.moedas + moedas;
        conta.ganhar(marca);                       // registra o pedido junto do saldo
        aviso(`Compra recebida: ${moedas ? '+' + fmt(moedas) + ' moedas' : o.items.map((x) => x.name).join(', ')}`);
      }
      await lojaApi('POST', 'confirmar', { code: o.code });
    }
  } catch { /* sem internet: tenta de novo depois */ }
  finally { entregando = false; }
}

// ao abrir o jogo e sempre que o jogador volta do navegador
document.addEventListener('visibilitychange', () => { if (!document.hidden) receberComprasDoSite(); });
setInterval(() => { if (!document.hidden) receberComprasDoSite(); }, 60000);
```

> `aviso`, `janela`, `fmt`, `ROUPAS`, `SKINS_ARMA`, `conta` e `fb` são os que o jogo já tem (`ui.js` / `conta.js`).

### 3.2 `web/jogo.js`

- Depois de cada `await carregarConta();` (linhas ~69 e ~98), adicione:
  ```js
  lojaApi('POST', 'entrar'); receberComprasDoSite();
  ```
- Em `telaMoedas()`, troque o clique dos botões de preço e o texto de rodapé:
  ```js
  for (const b of $$('[data-i]', t)) b.onclick = () => comprarNoSite(Number(b.dataset.i));
  ```
  Rodapé: `Pagamento por Pix no site oficial. As moedas entram sozinhas no jogo.`

### 3.3 APK: abrir links no navegador (`PonteJogo.kt`)

```kotlin
@JavascriptInterface fun abrirLink(url: String) {
    // só abre o site da loja (nada de links arbitrários vindos da página)
    if (!url.startsWith("https://nexus-p70i.onrender.com/")) return
    jogo.runOnUiThread { jogo.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
}
```

## 4. Testar
1. Abra o jogo logado, vá em **Loja de moedas** e toque em **R$ 24,99**.
2. O site abre no pagamento de 520 moedas, com seu ID. Pague (ou, para testar, confirme o pedido no painel).
3. Volte ao jogo: aparece "Compra recebida: +540 moedas" e o pedido vira **Entregue** no painel.

## Avisos
- **Google Play:** o rodapé atual fala em "Google Play Faturamento". Se um dia publicar **na Play Store**, a política
  dela não permite mandar o jogador pagar fora (Pix) por itens digitais dentro do app. Para APK distribuído pelo
  seu site, sem problema. Na Play, o caminho seria Play Billing + o site só registrando as vendas.
- As moedas ficam na conta do Firebase do jogo, gravadas pelo próprio celular (`usuarios/<uid>`). Isso deixa um
  jogador avançado editar o próprio saldo, se as regras do banco permitirem. O dinheiro real está protegido pelo
  site. Para blindar o saldo, o próximo passo seria o servidor do jogo gravar as moedas, e não o celular.
