import type { Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { WebSocket, WebSocketServer } from "ws";
import type {
  DeviceClientMessage,
  DeviceDirection,
  DeviceServerMessage,
} from "@opengym/shared";
import { db } from "./db.js";
import { logDeviceStatus, sweepStaleOnlineStatus } from "./deviceStatus.js";

const GATEWAY_PATH = "/api/device-gateway";
const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 30_000;

interface DeviceSocket extends WebSocket {
  deviceId?: string;
  deviceName?: string;
  // Turnstile direction: "in" means entry (occupancy +1, subscription checked),
  // "out" means exit (occupancy -1, no subscription check)
  direction?: DeviceDirection;
  isAlive?: boolean;
}

// Authenticated turnstile device connections—deviceId -> socket
const devices = new Map<string, DeviceSocket>();

function send(ws: WebSocket, msg: DeviceServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function touchLastSeen(deviceId: string): void {
  db.collection("devices")
    .updateOne(
      { _id: new ObjectId(deviceId) },
      { $set: { lastSeenAt: new Date() } },
    )
    .catch(console.error);
}

// Closes the old connection and registers the new one for the same device ID
function registerDevice(id: string, ws: DeviceSocket): void {
  const existing = devices.get(id);
  if (existing && existing !== ws) {
    existing.close(4000, "new connection");
  }
  devices.set(id, ws);
}

// Deletes from the registry only if it still points to the same socket (does not
// disrupt a replacement connection); logs "offline" for KPI-4 only on actual removal
function unregisterDevice(id: string, ws: DeviceSocket): void {
  if (devices.get(id) === ws) {
    devices.delete(id);
    logDeviceStatus(id, false);
  }
}

export function isDeviceOnline(id: string): boolean {
  return devices.has(id);
}

export function disconnectDevice(id: string): void {
  const ws = devices.get(id);
  if (ws) {
    ws.close(4001, "device removed");
    devices.delete(id);
    logDeviceStatus(id, false);
  }
}

// Sends a relay-open command to a connected device; returns false if unavailable
export function openDevice(id: string, openMs: number): boolean {
  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  send(ws, { type: "open", openMs });
  return true;
}

// Authentication failure: regardless of cause (bad message, unknown device,
// invalid token, timeout), send the same message to the client and close the connection
function failAuth(ws: WebSocket): void {
  send(ws, {
    type: "auth_error",
    message: "Device authentication failed.",
  });
  ws.close();
}

function isAuthMessage(
  msg: unknown,
): msg is Extract<DeviceClientMessage, { type: "auth" }> {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "auth" &&
    typeof (msg as { deviceId?: unknown }).deviceId === "string" &&
    typeof (msg as { token?: unknown }).token === "string"
  );
}

async function authenticate(
  ws: DeviceSocket,
  raw: WebSocket.RawData,
): Promise<void> {
  try {
    const msg: unknown = JSON.parse(raw.toString());
    if (!isAuthMessage(msg) || !ObjectId.isValid(msg.deviceId)) {
      throw new Error("invalid authentication message");
    }
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(msg.deviceId) });
    if (!device) {
      throw new Error("unknown device");
    }
    const tokenHash = createHash("sha256").update(msg.token).digest();
    const storedHash = Buffer.from(String(device.tokenHash), "hex");
    if (
      tokenHash.length !== storedHash.length ||
      !timingSafeEqual(tokenHash, storedHash)
    ) {
      throw new Error("invalid token");
    }

    ws.deviceId = msg.deviceId;
    ws.deviceName = device.name as string;
    ws.direction = (device.direction as DeviceDirection | undefined) ?? "in";
    ws.isAlive = true;
    registerDevice(msg.deviceId, ws);
    send(ws, { type: "auth_ok", deviceName: ws.deviceName });
    touchLastSeen(msg.deviceId);
    logDeviceStatus(msg.deviceId, true);
    // The device is now a dumb client: after auth it only listens for "open"
    // commands; incoming messages are ignored to avoid crashing old firmware.
    // Old firmware sends "scan" for every QR read—warn only once per connection
    // to prevent a log flood.
    let warnedUnexpectedMessage = false;
    ws.on("message", () => {
      if (warnedUnexpectedMessage) return;
      warnedUnexpectedMessage = true;
      console.warn(
        "unexpected message from device (ignored for this connection):",
        ws.deviceName,
      );
    });
  } catch (err) {
    console.warn("device authentication failed:", err);
    failAuth(ws);
  }
}

export function attachDeviceGateway(server: Server): void {
  // Closes status records stuck at "online: true" after a server crash/restart
  // so KPI-4 uptime is not incorrectly inflated
  sweepStaleOnlineStatus();

  // maxPayload: the device auth message is below 1 KB; prevent pre-auth memory
  // consumption through large frames
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    if (pathname !== GATEWAY_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const pingInterval = setInterval(() => {
    for (const [id, ws] of devices) {
      if (ws.isAlive === false) {
        ws.terminate();
        unregisterDevice(id, ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  wss.on("connection", (ws: DeviceSocket) => {
    let authenticated = false;

    // The error listener is required: without one, an "error" event crashes the
    // process (for example maxPayload exceeded, protocol violation, ECONNRESET)—
    // ws closes the connection itself
    ws.on("error", (err) => {
      console.warn("device socket error:", err.message);
    });

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        failAuth(ws);
      }
    }, AUTH_TIMEOUT_MS);

    ws.once("message", (raw) => {
      clearTimeout(authTimer);
      authenticate(ws, raw)
        .then(() => {
          authenticated = ws.deviceId !== undefined;
        })
        .catch((err) => {
          console.error("authentication error:", err);
        });
    });

    ws.on("pong", () => {
      ws.isAlive = true;
      if (ws.deviceId) {
        touchLastSeen(ws.deviceId);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (ws.deviceId) {
        unregisterDevice(ws.deviceId, ws);
      }
    });
  });
}
