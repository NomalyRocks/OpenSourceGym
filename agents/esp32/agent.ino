// OpenGym turnstile agent — ESP32 reference implementation.
//
// Libraries (Arduino Library Manager):
//   - "WebSockets" (Markus Sattler / links2004) >= 2.4
//   - "ArduinoJson" >= 7
//
// Hardware assumption:
//   - A relay module on GPIO26 (active HIGH) drives the turnstile trigger input.
//   - QR scanning no longer happens on the device but in the member's phone app;
//     this agent only authenticates and fires the relay on the server's "open"
//     command.
//
// Fail-closed: the relay defaults to LOW and only goes HIGH for openMs when the
// server sends "open". With no WiFi or no server, the relay never fires.

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---- Configuration (fill in your own values) ----
const char* WIFI_SSID    = "SSID";
const char* WIFI_PASS    = "PASSWORD";
const char* GW_HOST      = "192.168.1.10";               // API server
const uint16_t GW_PORT   = 3000;
const char* GW_PATH      = "/api/device-gateway";
const char* DEVICE_ID    = "DEVICE_ID";                  // from the panel
const char* DEVICE_TOKEN = "og_...";                     // from the panel, shown only once

const int RELAY_PIN = 26;
const unsigned long DEFAULT_OPEN_MS = 500;
// ------------------------------------------------------

WebSocketsClient webSocket;
unsigned long relayOffAt = 0;  // 0 = relay off, no pending close

void sendAuth() {
  JsonDocument doc;
  doc["type"] = "auth";
  doc["deviceId"] = DEVICE_ID;
  doc["token"] = DEVICE_TOKEN;
  String out;
  serializeJson(doc, out);
  webSocket.sendTXT(out);
}

void openRelay(unsigned long ms) {
  digitalWrite(RELAY_PIN, HIGH);
  relayOffAt = millis() + ms;
}

void onMessage(uint8_t* payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char* type = doc["type"];
  if (!type) return;

  if (strcmp(type, "auth_ok") == 0) {
    Serial.printf("[bagli] cihaz: %s\n", (const char*)(doc["deviceName"] | "?"));
  } else if (strcmp(type, "auth_error") == 0) {
    Serial.printf("[kimlik hatasi] %s\n", (const char*)(doc["message"] | "?"));
  } else if (strcmp(type, "open") == 0) {
    Serial.println("ACIK");
    openRelay(doc["openMs"] | DEFAULT_OPEN_MS);
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      sendAuth();
      break;
    case WStype_DISCONNECTED:
      Serial.println("[koptu] yeniden baglaniliyor...");
      break;
    case WStype_TEXT:
      onMessage(payload, length);
      break;
    default:
      break;
  }
}

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);  // relay off at boot (fail-closed)

  Serial.begin(115200);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi baglandi: %s\n", WiFi.localIP().toString().c_str());

  webSocket.begin(GW_HOST, GW_PORT, GW_PATH);
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(3000);  // automatic reconnect
  // The server sends a protocol ping every 30s; the library replies with a pong.
}

void loop() {
  webSocket.loop();

  // Close the relay once its window expires (without blocking)
  if (relayOffAt != 0 && (long)(millis() - relayOffAt) >= 0) {
    digitalWrite(RELAY_PIN, LOW);
    relayOffAt = 0;
  }
}
