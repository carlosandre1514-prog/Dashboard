package com.mobile3d

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// Conector genérico Android/Kotlin com o site NEXUS (painel de vendas + loja Pix).
// Para o Favela Stricker use sdk/favela-stricker/ (chave fica no servidor do jogo).
// Kotlin puro (HttpURLConnection + org.json), no mesmo estilo do Firebase.kt do jogo. Tudo roda fora da UI thread.
//
// O que ele faz:
//  - registra o jogador (aparece em "Jogadores" no painel) e envia telemetria (sessões, instalação)
//  - busca as compras feitas NO SITE já pagas e verificadas, para o jogo creditar, e confirma a entrega
//  - informa compras feitas DENTRO do jogo, quando houver Google Play Billing
//
// Plano grátis do Render: se o site estiver "dormindo", a 1ª chamada pode levar ~50 s. Por isso os tempos
// limite são longos, e nenhuma chamada trava o jogo: as respostas chegam por callback.
class NexusClient(
    private val baseUrl: String,               // ex.: "https://nexus-p70i.onrender.com"
    private val apiKey: String,                // Painel → Integração · API → chave do jogo
    private val signingSecret: String = "",    // opcional: segredo HMAC (se o painel exigir assinatura)
) {
    class Item(val sku: String, val name: String, val type: String, val qty: Int, val coins: Int)
    class Order(val code: String, val status: String, val totalCents: Int, val items: List<Item>)
    class Reply(val code: Int, val body: String) { val ok get() = code in 200..299 }

    private fun request(method: String, path: String, body: JSONObject? = null): Reply {
        val full = "/api/v1$path"
        val c = URL(baseUrl.trimEnd('/') + full).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 60_000   // o site gratuito pode estar acordando
            c.readTimeout = 60_000
            c.requestMethod = method
            c.setRequestProperty("Authorization", "Bearer $apiKey")
            val json = body?.toString() ?: ""
            if (signingSecret.isNotEmpty()) {
                // X-Nexus-Signature = HMAC-SHA256(segredo, "timestamp.MÉTODO./api/v1/caminho.corpo")
                val ts = (System.currentTimeMillis() / 1000).toString()
                val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(signingSecret.toByteArray(), "HmacSHA256")) }
                val sig = mac.doFinal("$ts.$method.$full.$json".toByteArray()).joinToString("") { "%02x".format(it) }
                c.setRequestProperty("X-Nexus-Timestamp", ts)
                c.setRequestProperty("X-Nexus-Signature", sig)
            }
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return Reply(code, text)
        } finally { c.disconnect() }
    }

    private fun async(block: () -> Unit) = Thread { try { block() } catch (_: Exception) { /* sem internet: tenta de novo na próxima vez */ } }.start()

    /** Ao abrir o jogo. playerId = o ID que o jogador digita no site para receber as compras. */
    fun registerPlayer(playerId: String, name: String? = null) = async {
        request("POST", "/players", JSONObject().put("external_id", playerId).put("username", name ?: JSONObject.NULL).put("platform", "android"))
    }

    /** Telemetria: "session_start" (partida/abertura), "install" (primeira abertura), "download". */
    fun track(type: String, playerId: String? = null) = async {
        request("POST", "/events", JSONObject().put("type", type).put("external_id", playerId ?: JSONObject.NULL).put("platform", "android"))
    }

    /**
     * Entrega as compras feitas no site (pagas, verificadas e fora de análise antifraude).
     * [grant] roda na thread de fundo, então use runOnUiThread para mexer na tela. Ele deve creditar o pedido e
     * devolver true. Só então o pedido é confirmado no site (ack). Se o jogo fechar no meio, o pedido continua
     * pendente e é entregue na próxima abertura (nunca some).
     */
    fun claimDeliveries(playerId: String, grant: (Order) -> Boolean) = async {
        val r = request("GET", "/deliveries?external_id=" + URLEncoder.encode(playerId, "UTF-8"))
        if (!r.ok) return@async
        val arr = JSONArray(r.body)
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val its = o.getJSONArray("items")
            val items = (0 until its.length()).map { k -> its.getJSONObject(k).let { Item(it.getString("sku"), it.getString("name"), it.getString("type"), it.getInt("qty"), it.optInt("coins")) } }
            val order = Order(o.getString("code"), o.getString("status"), o.getInt("total_cents"), items)
            if (grant(order)) request("POST", "/deliveries/${order.code}/ack")
        }
    }

    /** Compra feita DENTRO do jogo (Google Play Billing), depois que a Play confirmar. receipt = orderId da Play. */
    fun reportPurchase(playerId: String, sku: String, qty: Int, receipt: String) = async {
        request("POST", "/purchases", JSONObject()
            .put("external_id", playerId)
            .put("items", JSONArray().put(JSONObject().put("sku", sku).put("qty", qty)))
            .put("platform", "android").put("payment_method", "google_play").put("status", "paid").put("external_ref", receipt))
    }
}
