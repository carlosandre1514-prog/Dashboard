# NEXUS — cliente Godot 4 para a API v1
# Adicione como Autoload com o nome "Nexus" (Projeto → Configurações → Autoload).
extends Node

var base_url := "http://localhost:3000"
var api_key := ""

func _platform() -> String:
	match OS.get_name():
		"Android": return "android"
		"iOS": return "ios"
		"Web": return "web"
		_: return "pc"

func _send(method: int, path: String, body = null):
	var http := HTTPRequest.new()
	add_child(http)
	var headers := ["Authorization: Bearer " + api_key, "Content-Type: application/json"]
	var data := "" if body == null else JSON.stringify(body)
	var err := http.request(base_url.trim_suffix("/") + "/api/v1" + path, headers, method, data)
	if err != OK:
		http.queue_free()
		return null
	var res = await http.request_completed
	http.queue_free()
	var code: int = res[1]
	var text: String = res[3].get_string_from_utf8()
	if code >= 400:
		push_warning("[NEXUS] %s -> %d %s" % [path, code, text])
		return null
	return JSON.parse_string(text)

## Chame ao fazer login. player_id = ID interno do jogador no seu jogo.
func register_player(player_id: String, username: String = "") -> void:
	await _send(HTTPClient.METHOD_POST, "/players", {"external_id": player_id, "username": username, "platform": _platform()})

## Telemetria: "session_start", "install", "download".
func track(type: String, player_id: String = "") -> void:
	await _send(HTTPClient.METHOD_POST, "/events", {"type": type, "external_id": player_id, "platform": _platform()})

## Compra já paga na loja da plataforma (status "paid") ou "pending" para gerar Pix.
func report_purchase(player_id: String, sku: String, qty: int = 1, payment_method: String = "store", status: String = "paid", receipt_id: String = ""):
	return await _send(HTTPClient.METHOD_POST, "/purchases", {
		"external_id": player_id, "items": [{"sku": sku, "qty": qty}],
		"platform": _platform(), "payment_method": payment_method, "status": status, "external_ref": receipt_id,
	})

## Catálogo de produtos ativos (para montar a loja dentro do jogo).
func catalog():
	return await _send(HTTPClient.METHOD_GET, "/catalog")

## Retorna as compras pagas no site ainda não entregues.
## Credite os itens de cada pedido e DEPOIS chame ack_delivery(order.code).
func claim_deliveries(player_id: String) -> Array:
	var pending = await _send(HTTPClient.METHOD_GET, "/deliveries?external_id=" + player_id.uri_encode())
	return [] if pending == null else pending

## Confirma que os itens do pedido foram creditados (marca como "Entregue" no painel).
func ack_delivery(code: String) -> void:
	await _send(HTTPClient.METHOD_POST, "/deliveries/%s/ack" % code)
