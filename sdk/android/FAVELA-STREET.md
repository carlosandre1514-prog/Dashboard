# Conectando o Favela Street ao site NEXUS

O jogo (APK `com.mobile3d.policiaxbandidos`, pasta `app/src/jogo` do repositório Motor-Engine-3D) recebe
moedas, skins e armas compradas no site, e aparece no painel (jogadores, sessões e entregas).

## 1. No painel do site
1. **Jogos → Novo jogo**: nome `Favela Street`, moeda `Moedas`, plataforma Android, link do APK.
2. **Produtos** (os SKUs seguem esta regra para o jogo saber o que entregar):

| Tipo no painel | SKU | O que o jogo faz |
|---|---|---|
| Moeda | `MOEDAS_5000` (qualquer nome), com o campo **Moedas** = 5000 | soma às moedas do jogador |
| Skin | `SKIN_<chave da skin>` (ex.: `SKIN_policial_tatico`) | libera a skin (`skin:<chave>`) |
| Arma | `ARMA_<chave da arma>` (ex.: `ARMA_AK74_TATICA`) | libera a arma (`arma:<chave>`) |
| Skin de arma | `SKINARMA_<arma>_<skin>` (ex.: `SKINARMA_TT33_GOLD_RELIC`) | libera a skin da arma |

   A **chave** é a mesma do código (`Skin.key`, `Gun.key`, `GunSkin.gun/key` em `JogoActivity.kt`).
   Skins hoje: `pm civil exercito choque especial rubro alvinegro tricolor canarinho faixa`.
   Armas: `m4a1 m4colt ak47 ak74 ak74_tatica tt33`. Skins de arma: `tt33 crimson_forge`, `tt33 nebula_shadow`, `tt33 gold_relic`.
   SKU que não corresponde a nenhum item real do jogo é ignorado (não libera nada).
3. **Integração · API**: copie a **chave de API** do Favela Street.

## 2. No código do jogo
1. Copie `NexusClient.kt` para `app/src/jogo/java/com/mobile3d/`.
2. Em `JogoActivity.kt`:

```kotlin
// --- campos ---
private val nexus = NexusClient("https://nexus-p70i.onrender.com", "COLE_A_CHAVE_AQUI")

// ID curto e fixo do jogador: é o que ele digita no site para receber as compras
private val playerId: String by lazy {
    prefs.getString("nexus_id", null) ?: run {
        val abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val id = "FS" + (1..6).map { abc[(Math.random() * abc.length).toInt()] }.joinToString("")
        prefs.edit().putString("nexus_id", id).putBoolean("nexus_install", true).apply()
        id
    }
}

// --- entrega das compras do site ---
private fun claimStorePurchases() = nexus.claimDeliveries(playerId) { order ->
    var moedas = 0
    for (it in order.items) {
        val sku = it.sku.uppercase()
        // só libera itens que existem de verdade no jogo
        val skin = skins.find { s -> "SKIN_" + s.key.uppercase() == sku }
        val gun = guns.find { g -> "ARMA_" + g.key.uppercase() == sku }
        val gunSkin = gunSkins.find { g -> "SKINARMA_" + (g.gun + "_" + g.key).uppercase() == sku }
        when {
            skin != null -> addOwned("skin:" + skin.key)
            gun != null -> addOwned("arma:" + gun.key)
            gunSkin != null -> addOwned("skin_arma:${gunSkin.gun}:${gunSkin.key}")
            it.type == "currency" || it.coins > 0 -> moedas += it.coins * it.qty
        }
    }
    if (moedas > 0) coins += moedas
    runOnUiThread {
        toast(if (moedas > 0) "Compra da loja recebida: +${fmt(moedas)} moedas!" else "Compra da loja recebida!")
        if (screen.childCount > 0 && screen.getChildAt(0).tag == "inicio") showHome() // atualiza o saldo
    }
    true // creditado → confirma no site
}
```

3. Chame nos lugares certos:

```kotlin
// no fim de setup(...), depois de mostrar a tela inicial:
nexus.registerPlayer(playerId)
if (prefs.getBoolean("nexus_install", false)) { nexus.track("install", playerId); prefs.edit().remove("nexus_install").apply() }
claimStorePurchases()

// em onResume(), para quem pagou no site com o jogo aberto em segundo plano:
if (::screen.isInitialized) claimStorePurchases()

// em startMatch(...):
nexus.track("session_start", playerId)
```

4. **Mostre o ID na tela inicial** (em `showHome()`), com toque para copiar:

```kotlin
root.addView(label("Seu ID: $playerId  (toque para copiar)", 12f, textMain, true).apply {
    setPadding(dp(10), dp(6), dp(10), dp(6)); background = round(0x26FFFFFF, 10f)
    setOnClickListener {
        (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager)
            .setPrimaryClip(android.content.ClipData.newPlainText("ID", playerId))
        toast("ID copiado! Cole no site ao comprar.")
    }
}, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { topMargin = dp(60); rightMargin = dp(20) })
```

## 3. Testar
1. Gere o APK e abra o jogo: o jogador aparece em **Jogadores** e a instalação em **Ao vivo**.
2. No site, compre um pacote de moedas informando o ID mostrado no jogo e confirme o pagamento no painel.
3. Volte ao jogo (ou reabra): aparece "Compra da loja recebida", o saldo sobe e o pedido vira **Entregue** no painel.

## Observações
- As moedas do jogo ficam no celular (`SharedPreferences`), então alguém com o aparelho "rootado" consegue editar.
  O site protege o **dinheiro real**. Proteger o saldo dentro do jogo exige um servidor de jogo (próximo passo do online).
- **Google Play:** se publicar na Play Store, não coloque dentro do app botões ou links mandando comprar no site.
  A política da Play exige o pagamento da Play para itens digitais comprados dentro do app. O jogo pode entregar o
  que foi comprado fora dele; para vender dentro do app, use Google Play Billing + `nexus.reportPurchase(...)`.
