// NEXUS — cliente Unity para a API v1
// Coloque em Assets/Scripts, adicione o componente a um GameObject persistente e preencha baseUrl e apiKey.
//
// IMPORTANTE: a apiKey identifica o seu jogo. Em jogos com servidor próprio, prefira fazer estas chamadas
// pelo servidor. Em jogos só-cliente, registre compras apenas DEPOIS que a loja da plataforma
// (Google Play Billing, StoreKit, Steam) confirmar o pagamento.
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public class NexusClient : MonoBehaviour
{
    [Tooltip("Ex.: https://seusite.com")] public string baseUrl = "http://localhost:3000";
    [Tooltip("Chave do jogo em Painel → Integração · API")] public string apiKey = "";
    [Tooltip("Segredo de assinatura HMAC (opcional; obrigatório se o painel exigir assinatura). Prefira usar em servidor próprio.")] public string signingSecret = "";

    [Serializable] public class OrderItem { public string sku; public string name; public string type; public int qty; public int unit_cents; public int coins; }
    [Serializable] public class Order { public string code; public string status; public int total_cents; public int coins_total; public string external_player_id; public OrderItem[] items; }
    [Serializable] class OrderList { public Order[] items; }
    [Serializable] class PlayerBody { public string external_id; public string username; public string platform; public string country; }
    [Serializable] class EventBody { public string type; public string external_id; public string platform; }
    [Serializable] class PurchaseItem { public string sku; public int qty; }
    [Serializable] class PurchaseBody { public string external_id; public PurchaseItem[] items; public string platform; public string payment_method; public string external_ref; public string status; }

    string Platform => Application.platform == RuntimePlatform.Android ? "android"
                     : Application.platform == RuntimePlatform.IPhonePlayer ? "ios" : "pc";

    IEnumerator Send(string method, string path, object body, Action<string> ok, Action<string> fail = null)
    {
        var req = new UnityWebRequest(baseUrl.TrimEnd('/') + "/api/v1" + path, method);
        string json = body != null ? JsonUtility.ToJson(body) : "";
        if (body != null) req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
        if (!string.IsNullOrEmpty(signingSecret))
        {
            // X-Nexus-Signature = HMAC-SHA256(segredo, "timestamp.MÉTODO./api/v1/caminho.corpo")
            string ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            using (var h = new System.Security.Cryptography.HMACSHA256(Encoding.UTF8.GetBytes(signingSecret)))
            {
                var mac = h.ComputeHash(Encoding.UTF8.GetBytes($"{ts}.{method}./api/v1{path}.{json}"));
                req.SetRequestHeader("X-Nexus-Timestamp", ts);
                req.SetRequestHeader("X-Nexus-Signature", BitConverter.ToString(mac).Replace("-", "").ToLowerInvariant());
            }
        }
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Authorization", "Bearer " + apiKey);
        req.SetRequestHeader("Content-Type", "application/json");
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success) ok?.Invoke(req.downloadHandler.text);
        else { Debug.LogWarning($"[NEXUS] {method} {path}: {req.responseCode} {req.downloadHandler.text}"); fail?.Invoke(req.downloadHandler.text); }
        req.Dispose();
    }

    /// Chame ao fazer login no jogo. playerId = o ID interno do jogador no seu jogo.
    public IEnumerator RegisterPlayer(string playerId, string username = null) =>
        Send("POST", "/players", new PlayerBody { external_id = playerId, username = username, platform = Platform }, null);

    /// Telemetria: "session_start", "install", "download".
    public IEnumerator TrackEvent(string type, string playerId = null) =>
        Send("POST", "/events", new EventBody { type = type, external_id = playerId, platform = Platform }, null);

    /// Registra uma compra já paga na loja da plataforma. receiptId evita duplicidade.
    public IEnumerator ReportPurchase(string playerId, string sku, int qty, string paymentMethod, string receiptId, Action<Order> done = null) =>
        Send("POST", "/purchases", new PurchaseBody
        {
            external_id = playerId, items = new[] { new PurchaseItem { sku = sku, qty = qty } },
            platform = Platform, payment_method = paymentMethod, external_ref = receiptId, status = "paid"
        }, json => done?.Invoke(JsonUtility.FromJson<OrderWrapper>(json).order));
    [Serializable] class OrderWrapper { public Order order; }

    /// Busca compras feitas no site (pagas) e ainda não entregues. Para cada uma, credite os itens
    /// no callback — a confirmação (/ack) é enviada automaticamente em seguida.
    public IEnumerator ClaimDeliveries(string playerId, Action<Order> grant)
    {
        Order[] pending = null;
        yield return Send("GET", "/deliveries?external_id=" + UnityWebRequest.EscapeURL(playerId), null,
            json => pending = JsonUtility.FromJson<OrderList>("{\"items\":" + json + "}").items);
        if (pending == null) yield break;
        foreach (var order in pending)
        {
            grant(order); // ex.: Wallet.Add(item.coins * item.qty) para cada item
            yield return Send("POST", "/deliveries/" + order.code + "/ack", null, null);
        }
    }
}
