#!/usr/bin/env node
// OpenGym turnstile fleet simulator — Node >= 22 (global fetch + WebSocket), zero dependencies.
//
// Simulates multiple turnstiles in one process to test the gate flow end to end
// without a physical device (RPi/ESP32). Setup is automated because tokens are
// shown only once when a device is created: it deletes existing devices through
// the admin API, creates new ones, and writes their credentials to devices.json.
//
// Usage:
//   Setup: ADMIN_PASSWORD=... node fleet.mjs setup ["Name:in" "Name2:out" ...]
//          (default without arguments: "Entrance Turnstile:in" "Exit Turnstile:out")
//   Run:   node fleet.mjs
//
// Environment variables:
//   API_URL         default: http://127.0.0.1:3000
//   GATEWAY_URL     default: derived from API_URL (ws://.../api/device-gateway)
//   ADMIN_EMAIL     default: admin@opengym.local (setup only)
//   ADMIN_PASSWORD  required (setup only)
//   WEB_ORIGIN      default: http://localhost:5173 — BetterAuth CSRF protection
//                   requires an Origin header; must be a value in TRUSTED_ORIGINS

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

// ------------------------------------------------------------------- setup ---

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
    console.error(
      "The ADMIN_PASSWORD environment variable is required for setup.",
    );
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
    throw new Error("The login response did not include a session cookie");
  }
  return cookie;
}

// Parses "Name:direction" arguments; the direction is optional (default: "in")
function parseDeviceArgs(args) {
  return args.map((arg) => {
    const sep = arg.lastIndexOf(":");
    const name = sep === -1 ? arg : arg.slice(0, sep);
    const direction = sep === -1 ? "in" : arg.slice(sep + 1);
    if (!name || (direction !== "in" && direction !== "out")) {
      console.error(
        `Invalid device argument: "${arg}" — expected format: "Name:in" or "Name:out".`,
      );
      process.exit(2);
    }
    return { name, direction };
  });
}

async function setup(args) {
  const wanted = args.length > 0 ? parseDeviceArgs(args) : DEFAULT_DEVICES;
  const cookie = await adminLogin();

  // Clean setup: deletes all existing devices (also disconnects them from the gateway)
  const existing = await (await apiFetch("/api/admin/devices", cookie)).json();
  for (const device of existing) {
    await apiFetch(`/api/admin/devices/${device.id}`, cookie, {
      method: "DELETE",
    });
    console.log(`deleted: ${device.name}`);
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
      `created: ${created.name} (${created.direction}) — id ${created.id}`,
    );
  }

  // Contains tokens — file permission is 600 and it is excluded from Git (.gitignore)
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({ gatewayUrl: GATEWAY_URL, devices }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`\n${devices.length} devices written to ${CONFIG_PATH}.`);
  console.log(
    "You can view and print the static QR codes from the panel's Devices page.",
  );
  console.log("To start the simulator: node agents/sim/fleet.mjs");
}

// --------------------------------------------------------------------- run ---

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    console.error(
      `${CONFIG_PATH} could not be read — run setup first: ADMIN_PASSWORD=... node agents/sim/fleet.mjs setup`,
    );
    process.exit(2);
  }
}

// Same connection pattern as agent.mjs; per-device backoff and name-prefixed logs
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
        console.log(
          `[${device.name}] connected — waiting for an open command…`,
        );
        return;
      }

      if (msg.type === "auth_error") {
        // Retrying with an invalid token is pointless — this device is disabled,
        // while the rest of the fleet continues running.
        console.error(
          `[${device.name}] authentication error: ${msg.message} — run setup again.`,
        );
        ws.removeEventListener("close", onClose);
        ws.close();
      }

      if (msg.type === "open") {
        console.log(
          `[${device.name}] OPEN — relay triggered for ${msg.openMs ?? 500} ms`,
        );
      }
    });

    function onClose() {
      console.log(
        `[${device.name}] disconnected — reconnecting in ${Math.round(reconnectDelayMs / 1000)} seconds...`,
      );
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    }

    ws.addEventListener("close", onClose);
    // "error" is always followed by "close"; close handles reconnection.
    ws.addEventListener("error", () => {});
  }

  connect();
}

function run() {
  const config = loadConfig();
  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    console.error("devices.json is empty — run setup again.");
    process.exit(2);
  }
  console.log(
    `${config.devices.length} devices connecting to ${config.gatewayUrl}…`,
  );
  for (const device of config.devices) {
    connectDevice(config.gatewayUrl, device);
  }
}

if (process.argv[2] === "setup") {
  setup(process.argv.slice(3)).catch((err) => {
    console.error(`Setup failed: ${err.message}`);
    process.exit(1);
  });
} else {
  run();
}
