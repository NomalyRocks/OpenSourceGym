# Turnstile Device Agents

Device-side reference applications that connect to the revised Phase 4 Device Gateway. This directory is **outside** the pnpm workspace; the code is copied directly to the device.

Flow: a member scans a **static** QR code attached to the turnstile with their phone; the member's phone sends a request to the API, the API verifies the member, and sends a command over WebSocket to open the relay on **this device**. The device is now a "dumb client"—it does not scan QR codes itself; it only authenticates and waits for the open command from the server.

| Agent             | Platform                    | Purpose                    |
| ----------------- | --------------------------- | -------------------------- |
| `sim/agent.mjs`   | Node ≥ 22 (no dependencies) | Development/test simulator |
| `rpi/agent.py`    | Raspberry Pi (Python 3)     | GPIO relay                 |
| `esp32/agent.ino` | ESP32 (Arduino)             | Relay                      |

## Protocol

WebSocket, JSON text frame, endpoint: `ws://<api-host>:3000/api/device-gateway`
(types: `packages/shared` → `DeviceClientMessage` / `DeviceServerMessage`)

1. The device authenticates as soon as the connection opens (first message, within 5 seconds):
   ```json
   { "type": "auth", "deviceId": "<device id from panel>", "token": "og_..." }
   ```
   Response: `{"type":"auth_ok","deviceName":"..."}` or `{"type":"auth_error","message":"..."}` + the connection closes.
2. After authentication, the device does not send any messages; it only listens for the open command from the server:
   ```json
   { "type": "open", "openMs": 500 }
   ```
   This command is sent when a member scans the static QR for this device shown in the panel with their phone and passes all server-side checks (subscription, location, account sharing, etc.).
3. The server sends a WebSocket ping every 30 seconds; the client libraries in use respond with a pong automatically. A connection that does not return a pong is closed by the server, and the device appears as "Offline" in the panel.

## Configuration

Create the device from **Devices → Add device** in the panel. The returned token with the `og_` prefix is shown **only once**—save it on the device. If you lose it, delete the device and add it again (the server stores only the token's hash). The same panel also displays and prints the **printable static QR** for that device—attach this QR to the turnstile.

| Variable       | Default                                  | Description                        |
| -------------- | ---------------------------------------- | ---------------------------------- |
| `GATEWAY_URL`  | `ws://127.0.0.1:3000/api/device-gateway` | Gateway address                    |
| `DEVICE_ID`    | — (required)                             | Device ID from the panel           |
| `DEVICE_TOKEN` | — (required)                             | Device token with the `og_` prefix |
| `RELAY_GPIO`   | `17`                                     | Relay BCM pin (RPi only)           |

On the ESP32, configuration is defined by the constants at the start of `agent.ino` (WiFi, host, ID, token).

> **Production note:** If you expose the API to the internet, put the gateway behind TLS
> (`wss://` through a reverse proxy)—the token is sent in a plain-text frame.

## Fail-closed behavior

All agents apply the same rule: **the relay is closed by default and opens for `openMs` only when the `open` command arrives from the server.** When WiFi disconnects, the server is unreachable, or authentication fails, the relay is never triggered; the device automatically attempts to reconnect (exponential backoff / library reconnect). Members see this condition as a "No turnstile connection" warning after scanning.

## Using the simulator

```bash
DEVICE_ID=... DEVICE_TOKEN=og_... node agents/sim/agent.mjs
```

It connects, authenticates, and waits for the `open` command from the server; you can trigger the open command by scanning this device's QR from the panel with a phone or by triggering the `POST /api/me/gate-scan` request.

### Fleet simulator (`sim/fleet.mjs`)

It simulates multiple turnstiles in one process without physical hardware; setup is also automatic (there is no need to copy the token manually):

```bash
# One-time setup: DELETES ALL EXISTING DEVICES, creates new ones,
# writes credentials to agents/sim/devices.json (not tracked by git, mode 600)
# default: "Giriş Turnikesi"(in) + "Çıkış Turnikesi"(out)
ADMIN_PASSWORD=... pnpm sim:setup
# custom list, format "Name:in|out"
ADMIN_PASSWORD=... pnpm sim:setup "Yan Kapı:in"

# Run: opens a WebSocket for each device in devices.json
pnpm sim
```

Customize with the `API_URL` (default `http://127.0.0.1:3000`), `GATEWAY_URL`, and `ADMIN_EMAIL` (default `admin@opengym.local`) environment variables. Logs are prefixed with the device name; when the `open` command arrives, it writes `[Name] OPEN — relay N ms`.

## Hardware connections

**Raspberry Pi (`rpi/agent.py`)**

- Relay module: `IN` → BCM 17 (default), `VCC` → 5V, `GND` → GND. Connect the relay output to the turnstile trigger input (dry contact).
- Running it as a systemd service after `pip install websockets gpiozero` is recommended.

**ESP32 (`agent.ino`)**

- Relay `IN` → GPIO26 (active HIGH).
- Libraries: WebSockets (links2004) ≥ 2.4, ArduinoJson ≥ 7.
