#!/usr/bin/env node
// OpenGym turnstile simulator — Node >= 22 (global WebSocket), zero dependencies.
//
// Usage:
//   DEVICE_ID=... DEVICE_TOKEN=og_... node agent.mjs
//
// The device is now a "dumb client": it authenticates, stays connected, and waits
// for an "open" command from the server (member scanning now happens in the phone
// app, not on the device). This agent only simulates the connection and relay.
//
// Environment variables:
//   GATEWAY_URL   default: ws://127.0.0.1:3000/api/device-gateway
//   DEVICE_ID     ID of the device added from the panel
//   DEVICE_TOKEN  "og_"-prefixed token shown only once when the device is added

import process from "node:process";

const GATEWAY_URL =
  process.env.GATEWAY_URL ?? "ws://127.0.0.1:3000/api/device-gateway";
const DEVICE_ID = process.env.DEVICE_ID;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

if (!DEVICE_ID || !DEVICE_TOKEN) {
  console.error(
    "The DEVICE_ID and DEVICE_TOKEN environment variables are required.",
  );
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
        `[connected] device: ${msg.deviceName} — waiting for an open command…`,
      );
      return;
    }

    if (msg.type === "auth_error") {
      // Retrying with an invalid token is pointless — exit.
      console.error(`[authentication error] ${msg.message}`);
      process.exit(2);
    }

    if (msg.type === "open") {
      console.log(`OPEN — relay triggered for ${msg.openMs ?? 500} ms`);
    }
  });

  ws.addEventListener("close", () => {
    console.log(
      `[disconnected] reconnecting in ${Math.round(reconnectDelayMs / 1000)} seconds...`,
    );
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  });

  // "error" is always followed by "close"; close handles reconnection.
  ws.addEventListener("error", () => {});
}

connect();
