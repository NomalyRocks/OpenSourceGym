#!/usr/bin/env node
// OpenGym turnike simülatörü — Node >= 22 (global WebSocket), sıfır bağımlılık.
//
// Kullanım:
//   DEVICE_ID=... DEVICE_TOKEN=og_... node agent.mjs
//
// Cihaz artık "dumb client": kimlik doğrular, bağlı kalır ve sunucudan gelen
// "open" komutunu bekler (üye taraması artık cihazda değil, telefon
// uygulamasında gerçekleşir). Bu ajan yalnızca bağlantı/röle simülasyonudur.
//
// Ortam değişkenleri:
//   GATEWAY_URL   varsayılan: ws://127.0.0.1:3000/api/device-gateway
//   DEVICE_ID     panelden eklenen cihazın id'si
//   DEVICE_TOKEN  cihaz eklenirken yalnızca bir kez gösterilen "og_" önekli token

import process from "node:process";

const GATEWAY_URL =
  process.env.GATEWAY_URL ?? "ws://127.0.0.1:3000/api/device-gateway";
const DEVICE_ID = process.env.DEVICE_ID;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

if (!DEVICE_ID || !DEVICE_TOKEN) {
  console.error("DEVICE_ID ve DEVICE_TOKEN ortam değişkenleri zorunlu.");
  process.exit(2);
}

let reconnectDelayMs = 1000;

function connect() {
  const ws = new WebSocket(GATEWAY_URL);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "auth",
        deviceId: DEVICE_ID,
        token: DEVICE_TOKEN,
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (msg.type === "auth_ok") {
      reconnectDelayMs = 1000;
      console.log(
        `[bağlı] cihaz: ${msg.deviceName} — açılma komutu bekleniyor…`,
      );
      return;
    }

    if (msg.type === "auth_error") {
      // Token yanlışsa yeniden denemenin anlamı yok — çık.
      console.error(`[kimlik hatası] ${msg.message}`);
      process.exit(2);
    }

    if (msg.type === "open") {
      console.log(`AÇIK — röle ${msg.openMs ?? 500} ms tetiklendi`);
    }
  });

  ws.addEventListener("close", () => {
    console.log(
      `[koptu] ${Math.round(reconnectDelayMs / 1000)} sn sonra yeniden bağlanılacak...`,
    );
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  });

  // "error" sonrasında her zaman "close" gelir; yeniden bağlanmayı close yönetir.
  ws.addEventListener("error", () => {});
}

connect();
