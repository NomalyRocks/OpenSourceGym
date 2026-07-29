# Turnike Cihaz Ajanları

Faz 4 (revize) Device Gateway'e bağlanan cihaz tarafı referans uygulamaları. Bu dizin pnpm workspace'in **dışındadır**; kod doğrudan cihaza kopyalanır.

Akış: turnikeye yapıştırılmış **statik** bir QR kodu üye telefonuyla okutulur; üyenin telefonu API'ye istek atar, API üyeyi doğrular ve **bu cihaza** WebSocket üzerinden röleyi açma komutu gönderir. Cihaz artık "dumb client"tır — kendi başına QR okumaz, yalnızca kimlik doğrular ve sunucudan gelen açma komutunu bekler.

| Ajan              | Platform                   | Ne için                    |
| ----------------- | -------------------------- | -------------------------- |
| `sim/agent.mjs`   | Node ≥ 22 (bağımlılık yok) | Geliştirme/test simülatörü |
| `rpi/agent.py`    | Raspberry Pi (Python 3)    | GPIO röle                  |
| `esp32/agent.ino` | ESP32 (Arduino)            | Röle                       |

## Protokol

WebSocket, JSON text frame, endpoint: `ws://<api-host>:3000/api/device-gateway`
(tipler: `packages/shared` → `DeviceClientMessage` / `DeviceServerMessage`)

1. Bağlantı açılır açılmaz cihaz kimlik doğrular (ilk mesaj, 5 sn içinde):
   ```json
   { "type": "auth", "deviceId": "<panel'deki cihaz id>", "token": "og_..." }
   ```
   Yanıt: `{"type":"auth_ok","deviceName":"..."}` veya `{"type":"auth_error","message":"..."}` + bağlantı kapanır.
2. Kimlik doğrulama sonrası cihaz herhangi bir mesaj göndermez; yalnızca sunucudan gelen açma komutunu dinler:
   ```json
   { "type": "open", "openMs": 500 }
   ```
   Bu komut, bir üye telefonuyla panelde bu cihaza ait statik QR'ı okutup sunucu tarafındaki tüm kontrolleri (abonelik, konum, hesap paylaşımı vb.) geçtiğinde gönderilir.
3. Sunucu 30 sn'de bir WebSocket ping atar; kullanılan istemci kütüphaneleri otomatik pong yanıtlar. Pong gelmeyen bağlantı sunucu tarafında kapatılır ve cihaz panelde "Çevrimdışı" görünür.

## Yapılandırma

Cihaz, panelde **Cihazlar → Cihaz ekle** ile oluşturulur. Dönen `og_` önekli token **yalnızca bir kez** gösterilir — cihaza kaydedin. Kaybederseniz cihazı silip yeniden ekleyin (sunucu yalnızca token'ın hash'ini saklar). Aynı panelde, o cihaza ait **yazdırılabilir statik QR** da görüntülenir/yazdırılır — bu QR'ı turnikeye yapıştırın.

| Değişken       | Varsayılan                               | Açıklama                   |
| -------------- | ---------------------------------------- | -------------------------- |
| `GATEWAY_URL`  | `ws://127.0.0.1:3000/api/device-gateway` | Gateway adresi             |
| `DEVICE_ID`    | — (zorunlu)                              | Paneldeki cihaz id'si      |
| `DEVICE_TOKEN` | — (zorunlu)                              | `og_` önekli cihaz token'ı |
| `RELAY_GPIO`   | `17`                                     | (yalnız RPi) Röle BCM pini |

ESP32'de yapılandırma `agent.ino` başındaki sabitlerdedir (WiFi, host, id, token).

> **Üretim notu:** API'yi internete açıyorsanız gateway'i TLS arkasına alın
> (reverse proxy ile `wss://`) — token düz metin frame'de gider.

## Fail-closed davranışı

Tüm ajanlar aynı kuralı uygular: **röle varsayılan olarak kapalıdır ve yalnızca sunucudan `open` komutu geldiğinde `openMs` süresince açılır.** WiFi koptuğunda, sunucu erişilemez olduğunda veya kimlik doğrulama başarısız olduğunda röle hiç tetiklenmez; cihaz otomatik yeniden bağlanmayı dener (üstel geri çekilme / kütüphane reconnect'i). Üye tarafında bu durum, tarama sonrası "Turnike bağlantısı yok" uyarısıyla görünür.

## Simülatör kullanımı

```bash
DEVICE_ID=... DEVICE_TOKEN=og_... node agents/sim/agent.mjs
```

Bağlanır, kimlik doğrular ve sunucudan `open` komutu gelene kadar bekler; panelden bu cihaza ait QR'ı bir telefonla okutarak veya `POST /api/me/gate-scan` isteğini tetikleyerek açılma komutunu tetikleyebilirsiniz.

### Filo simülatörü (`sim/fleet.mjs`)

Fiziksel donanım olmadan birden fazla turnikeyi tek süreçte simüle eder; kurulumu da otomatiktir (token'ı elle kopyalamak gerekmez):

```bash
# Tek seferlik kurulum: MEVCUT TÜM CİHAZLARI SİLER, yenilerini oluşturur,
# kimlik bilgilerini agents/sim/devices.json'a yazar (git'e girmez, izin 600)
ADMIN_PASSWORD=... pnpm sim:setup                 # varsayılan: Giriş(in) + Çıkış(out)
ADMIN_PASSWORD=... pnpm sim:setup "Yan Kapı:in"   # özel liste: "Ad:in|out" ...

# Çalıştırma: devices.json'daki her cihaz için bir WebSocket açar
pnpm sim
```

`API_URL` (varsayılan `http://127.0.0.1:3000`), `GATEWAY_URL` ve `ADMIN_EMAIL` (varsayılan `admin@opengym.local`) ortam değişkenleriyle özelleştirilir. Loglar cihaz adı öneklidir; `open` komutu geldiğinde `[Ad] AÇIK — röle N ms` yazar.

## Donanım bağlantısı

**Raspberry Pi (`rpi/agent.py`)**

- Röle modülü: `IN` → BCM 17 (varsayılan), `VCC` → 5V, `GND` → GND. Röle çıkışı turnikenin tetik girişine (kuru kontak).
- `pip install websockets gpiozero` sonrası systemd servisi olarak çalıştırılması önerilir.

**ESP32 (`agent.ino`)**

- Röle `IN` → GPIO26 (aktif HIGH).
- Kütüphaneler: WebSockets (links2004) ≥ 2.4, ArduinoJson ≥ 7.
