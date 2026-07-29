#!/usr/bin/env node
// OpenGym turnike filo simülatörü — Node >= 22 (global fetch + WebSocket), sıfır bağımlılık.
//
// Fiziksel cihaz (RPi/ESP32) olmadan gate akışını uçtan uca test etmek için
// birden fazla turnikeyi tek süreçte simüle eder. Token'lar cihaz oluşturulurken
// yalnızca bir kez göründüğünden kurulum da otomatiktir: admin API ile mevcut
// cihazları siler, yenilerini oluşturur ve kimlik bilgilerini devices.json'a yazar.
//
// Kullanım:
//   Kurulum:    ADMIN_PASSWORD=... node fleet.mjs setup ["Ad:in" "Ad2:out" ...]
//               (argümansız varsayılan: "Giriş Turnikesi:in" "Çıkış Turnikesi:out")
//   Çalıştırma: node fleet.mjs
//
// Ortam değişkenleri:
//   API_URL         varsayılan: http://127.0.0.1:3000
//   GATEWAY_URL     varsayılan: API_URL'den türetilir (ws://.../api/device-gateway)
//   ADMIN_EMAIL     varsayılan: admin@opengym.local (yalnız setup)
//   ADMIN_PASSWORD  zorunlu (yalnız setup)
//   WEB_ORIGIN      varsayılan: http://localhost:5173 — BetterAuth CSRF koruması
//                   Origin başlığı ister; TRUSTED_ORIGINS'teki bir değer olmalı

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3000";
const GATEWAY_URL =
  process.env.GATEWAY_URL ??
  `${API_URL.replace(/^http/, "ws")}/api/device-gateway`;
const CONFIG_PATH = fileURLToPath(new URL("devices.json", import.meta.url));
const DEFAULT_DEVICES = [
  { name: "Giriş Turnikesi", direction: "in" },
  { name: "Çıkış Turnikesi", direction: "out" },
];

// ---------------------------------------------------------------- kurulum ---

async function apiFetch(path, cookie, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${options.method ?? "GET"} ${path} → ${res.status} ${body}`,
    );
  }
  return res;
}

async function adminLogin() {
  const email = process.env.ADMIN_EMAIL ?? "admin@opengym.local";
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error("Kurulum için ADMIN_PASSWORD ortam değişkeni zorunlu.");
    process.exit(2);
  }
  const res = await apiFetch("/api/auth/sign-in/email", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" },
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) {
    throw new Error("giriş yanıtında oturum çerezi yok");
  }
  return cookie;
}

// "Ad:yön" argümanlarını çözer; yön kısmı isteğe bağlıdır (varsayılan "in")
function parseDeviceArgs(args) {
  return args.map((arg) => {
    const sep = arg.lastIndexOf(":");
    const name = sep === -1 ? arg : arg.slice(0, sep);
    const direction = sep === -1 ? "in" : arg.slice(sep + 1);
    if (!name || (direction !== "in" && direction !== "out")) {
      console.error(
        `Geçersiz cihaz argümanı: "${arg}" — beklenen biçim "Ad:in" veya "Ad:out".`,
      );
      process.exit(2);
    }
    return { name, direction };
  });
}

async function setup(args) {
  const wanted = args.length > 0 ? parseDeviceArgs(args) : DEFAULT_DEVICES;
  const cookie = await adminLogin();

  // Temiz kurulum: mevcut tüm cihazlar silinir (bağlıysa gateway'den de düşer)
  const existing = await (await apiFetch("/api/admin/devices", cookie)).json();
  for (const device of existing) {
    await apiFetch(`/api/admin/devices/${device.id}`, cookie, {
      method: "DELETE",
    });
    console.log(`silindi: ${device.name}`);
  }

  const devices = [];
  for (const { name, direction } of wanted) {
    const created = await (
      await apiFetch("/api/admin/devices", cookie, {
        method: "POST",
        body: JSON.stringify({ name, direction }),
      })
    ).json();
    devices.push({
      id: created.id,
      name: created.name,
      direction: created.direction,
      token: created.token,
    });
    console.log(
      `oluşturuldu: ${created.name} (${created.direction}) — id ${created.id}`,
    );
  }

  // Token içerir — dosya izni 600, git'e girmez (.gitignore)
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({ gatewayUrl: GATEWAY_URL, devices }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`\n${devices.length} cihaz ${CONFIG_PATH} dosyasına yazıldı.`);
  console.log(
    "Statik QR'ları panel → Cihazlar sayfasından görüntüleyip yazdırabilirsiniz.",
  );
  console.log("Simülatörü başlatmak için: node agents/sim/fleet.mjs");
}

// ------------------------------------------------------------- çalıştırma ---

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    console.error(
      `${CONFIG_PATH} okunamadı — önce kurulum çalıştırın: ADMIN_PASSWORD=... node agents/sim/fleet.mjs setup`,
    );
    process.exit(2);
  }
}

// agent.mjs ile aynı bağlantı deseni; cihaz başına ayrı backoff, loglar ad önekli
function connectDevice(gatewayUrl, device) {
  let reconnectDelayMs = 1000;

  function connect() {
    const ws = new WebSocket(gatewayUrl);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "auth",
          deviceId: device.id,
          token: device.token,
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
        console.log(`[${device.name}] bağlı — açılma komutu bekleniyor…`);
        return;
      }

      if (msg.type === "auth_error") {
        // Token yanlışsa yeniden denemenin anlamı yok — bu cihaz devre dışı,
        // filonun kalanı çalışmaya devam eder.
        console.error(
          `[${device.name}] kimlik hatası: ${msg.message} — kurulumu yeniden çalıştırın.`,
        );
        ws.removeEventListener("close", onClose);
        ws.close();
      }

      if (msg.type === "open") {
        console.log(
          `[${device.name}] AÇIK — röle ${msg.openMs ?? 500} ms tetiklendi`,
        );
      }
    });

    function onClose() {
      console.log(
        `[${device.name}] koptu — ${Math.round(reconnectDelayMs / 1000)} sn sonra yeniden bağlanılacak...`,
      );
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    }

    ws.addEventListener("close", onClose);
    // "error" sonrasında her zaman "close" gelir; yeniden bağlanmayı close yönetir.
    ws.addEventListener("error", () => {});
  }

  connect();
}

function run() {
  const config = loadConfig();
  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    console.error("devices.json boş — kurulumu yeniden çalıştırın.");
    process.exit(2);
  }
  console.log(
    `${config.devices.length} cihaz ${config.gatewayUrl} adresine bağlanıyor…`,
  );
  for (const device of config.devices) {
    connectDevice(config.gatewayUrl, device);
  }
}

if (process.argv[2] === "setup") {
  setup(process.argv.slice(3)).catch((err) => {
    console.error(`Kurulum başarısız: ${err.message}`);
    process.exit(1);
  });
} else {
  run();
}
