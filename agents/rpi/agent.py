#!/usr/bin/env python3
# OpenGym turnstile agent — Raspberry Pi reference implementation.
#
# Requirements:
#   pip install websockets gpiozero
#
# Hardware assumptions:
#   - The relay module is connected to a GPIO pin (default: BCM 17) and drives the
#     turnstile trigger input.
#   - QR scanning now happens in the member's phone app, not on the device;
#     this agent only authenticates and triggers the relay with the server's "open" command.
#
# Environment variables:
#   GATEWAY_URL   default: ws://127.0.0.1:3000/api/device-gateway
#   DEVICE_ID     ID of the device added from the panel
#   DEVICE_TOKEN  "og_"-prefixed token shown only once when the device is added
#   RELAY_GPIO    default: 17 (BCM)
#
# Fail-closed: the relay is OFF by default and turns on for openMs only when an
# "open" command arrives from the server. No command opens the gate while disconnected.

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    sys.exit("The websockets package is required: pip install websockets")

GATEWAY_URL = os.environ.get("GATEWAY_URL", "ws://127.0.0.1:3000/api/device-gateway")
DEVICE_ID = os.environ.get("DEVICE_ID")
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN")
RELAY_GPIO = int(os.environ.get("RELAY_GPIO", "17"))

if not DEVICE_ID or not DEVICE_TOKEN:
    sys.exit("The DEVICE_ID and DEVICE_TOKEN environment variables are required.")


class DummyRelay:
    """Simulate the relay in an environment without GPIO, such as a development machine."""

    def on(self):
        print("[relay] OPEN (simulation)")

    def off(self):
        print("[relay] CLOSED (simulation)")


try:
    from gpiozero import OutputDevice

    # initial_value=False → relay is off at startup (fail-closed)
    relay = OutputDevice(RELAY_GPIO, active_high=True, initial_value=False)
except Exception:
    relay = DummyRelay()


async def pulse_relay(open_ms: int) -> None:
    # The relay opens only for a fixed duration and always closes in finally.
    relay.on()
    try:
        await asyncio.sleep(open_ms / 1000)
    finally:
        relay.off()


async def handle_messages(ws) -> None:
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "open":
            print("OPEN")
            asyncio.create_task(pulse_relay(int(msg.get("openMs", 500))))


async def run() -> None:
    delay = 1
    while True:
        try:
            # The websockets library automatically responds to server pings (keepalive).
            async with websockets.connect(GATEWAY_URL) as ws:
                await ws.send(
                    json.dumps(
                        {"type": "auth", "deviceId": DEVICE_ID, "token": DEVICE_TOKEN}
                    )
                )
                first = json.loads(await ws.recv())
                if first.get("type") != "auth_ok":
                    # Retrying with an invalid token is pointless — exit.
                    sys.exit(f"[authentication error] {first.get('message', '?')}")
                print(f"[connected] device: {first.get('deviceName')} — waiting for an open command…")
                delay = 1

                await handle_messages(ws)  # returns when the connection drops
        except (OSError, websockets.WebSocketException) as exc:
            print(f"[disconnected] {exc} — reconnecting in {delay} seconds...")

        await asyncio.sleep(delay)
        delay = min(delay * 2, 30)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    finally:
        relay.off()  # fail-closed on every exit
