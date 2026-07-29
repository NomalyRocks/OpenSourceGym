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
  // Turnike yönü: "in" giriş (doluluk +1, abonelik kontrolü var), "out" çıkış
  // (doluluk -1, abonelik kontrolü yok)
  direction?: DeviceDirection;
  isAlive?: boolean;
}

// Kimliği doğrulanmış turnike cihazı bağlantıları — deviceId -> soket
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

// Aynı cihaz kimliğiyle yeni bir bağlantı geldiğinde eskisini kapatıp yenisini kaydeder
function registerDevice(id: string, ws: DeviceSocket): void {
  const existing = devices.get(id);
  if (existing && existing !== ws) {
    existing.close(4000, "new connection");
  }
  devices.set(id, ws);
}

// Registry'den yalnızca hâlâ aynı soketi işaret ediyorsa siler (yer değiştirmiş
// bağlantıyı bozmaz); kayıt gerçekten kaldırıldığında KPI-4 için "offline" loglanır
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

// Bağlı cihaza röle açma komutu gönderir; cihaz bağlı/açık değilse false döner
export function openDevice(id: string, openMs: number): boolean {
  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  send(ws, { type: "open", openMs });
  return true;
}

// Kimlik doğrulama başarısızlığı: sebep ne olursa olsun (kötü mesaj, bilinmeyen
// cihaz, yanlış token, zaman aşımı) istemciye aynı mesaj gönderilip bağlantı kapatılır
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
      throw new Error("geçersiz kimlik doğrulama mesajı");
    }
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(msg.deviceId) });
    if (!device) {
      throw new Error("bilinmeyen cihaz");
    }
    const tokenHash = createHash("sha256").update(msg.token).digest();
    const storedHash = Buffer.from(String(device.tokenHash), "hex");
    if (
      tokenHash.length !== storedHash.length ||
      !timingSafeEqual(tokenHash, storedHash)
    ) {
      throw new Error("geçersiz token");
    }

    ws.deviceId = msg.deviceId;
    ws.deviceName = device.name as string;
    ws.direction = (device.direction as DeviceDirection | undefined) ?? "in";
    ws.isAlive = true;
    registerDevice(msg.deviceId, ws);
    send(ws, { type: "auth_ok", deviceName: ws.deviceName });
    touchLastSeen(msg.deviceId);
    logDeviceStatus(msg.deviceId, true);
    // Cihaz artık dumb client: auth sonrası yalnızca "open" komutu dinler,
    // kendisinden gelen mesajlar yok sayılır (eski firmware'i çökertmemek için).
    // Eski firmware her QR okutuşunda "scan" gönderir — log seli olmasın diye
    // bağlantı başına yalnızca bir kez uyarılır.
    let warnedUnexpectedMessage = false;
    ws.on("message", () => {
      if (warnedUnexpectedMessage) return;
      warnedUnexpectedMessage = true;
      console.warn(
        "cihazdan beklenmeyen mesaj (bu bağlantıda yok sayılacak):",
        ws.deviceName,
      );
    });
  } catch (err) {
    console.warn("cihaz kimlik doğrulaması başarısız:", err);
    failAuth(ws);
  }
}

export function attachDeviceGateway(server: Server): void {
  // Sunucu çöktükten/yeniden başladıktan sonra "online: true" takılı kalmış
  // durum kayıtlarını kapatır (KPI-4 uptime hesaplaması yanlış şişmesin diye)
  sweepStaleOnlineStatus();

  // maxPayload: cihaz mesajı (auth) 1 KB altındadır; büyük frame'lerle
  // kimlik doğrulaması öncesi bellek tüketimini engeller
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

    // error dinleyicisi zorunlu: dinleyicisiz "error" event'i süreci çökertir
    // (ör. maxPayload aşımı, protokol ihlali, ECONNRESET) — ws bağlantıyı kendisi kapatır
    ws.on("error", (err) => {
      console.warn("cihaz soketi hatası:", err.message);
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
          console.error("kimlik doğrulama hatası:", err);
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
