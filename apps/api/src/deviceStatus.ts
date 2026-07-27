import { db } from "./db.js";

const COLLECTION = "device_status_log";
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface DeviceStatusLogDoc {
  deviceId: string;
  online: boolean;
  at: Date;
}

interface DeviceUptimeInput {
  deviceId: string;
  nowOnline: boolean;
}

interface GroupedInWindowLogs {
  _id: string;
  logs: DeviceStatusLogDoc[];
}

interface GroupedBeforeLog {
  _id: string;
  log: DeviceStatusLogDoc;
}

interface UptimeAggregationResult {
  inWindow: GroupedInWindowLogs[];
  before: GroupedBeforeLog[];
}

// Cihaz bağlantı durumu geçmişi (KPI-4: son 24 saat çevrimiçi kalma yüzdesi).
// Fire-and-forget: API/Gateway akışını bloklamaz, hata konsola düşer.
export function logDeviceStatus(deviceId: string, online: boolean): void {
  db.collection<DeviceStatusLogDoc>(COLLECTION)
    .insertOne({ deviceId, online, at: new Date() })
    .catch((err) => {
      console.error("cihaz durum kaydı yazılamadı:", err);
    });
}

// Sunucu çöktükten/yeniden başladıktan sonra "online: true" olarak kalmış
// cihazlar için kurtarma: her cihazın en son kaydı online ise bir "false"
// kaydı eklenir (aksi halde uptime hesaplaması cihazı sonsuza dek çevrimiçi sanır)
export function sweepStaleOnlineStatus(): void {
  (async () => {
    const collection = db.collection<DeviceStatusLogDoc>(COLLECTION);
    const deviceIds = await collection.distinct("deviceId");
    for (const deviceId of deviceIds) {
      const latest = await collection
        .find({ deviceId })
        .sort({ at: -1 })
        .limit(1)
        .next();
      if (latest?.online === true) {
        await collection.insertOne({ deviceId, online: false, at: new Date() });
      }
    }
  })().catch((err) => {
    console.error("cihaz durum geçmişi başlangıç taraması başarısız:", err);
  });
}

function calculateUptime24h(
  inWindow: DeviceStatusLogDoc[],
  before: DeviceStatusLogDoc | undefined,
  nowOnline: boolean,
  now: number,
  windowStart: Date,
): number {
  if (inWindow.length === 0) {
    if (!before) {
      // Hiç kayıt yok: cihazın şu anki durumu pencere boyunca sabit kabul edilir
      return nowOnline ? 100 : 0;
    }
    return before.online ? 100 : 0;
  }

  const firstInWindow = inWindow[0]!;
  // Pencere başındaki durum: öncesinde bir kayıt varsa o durum, yoksa
  // penceredeki ilk kaydın kendisi bir durum DEĞİŞİKLİĞİ olduğundan öncesinin
  // tersi olduğu varsayılır
  let state = before ? before.online : !firstInWindow.online;
  let cursor = windowStart.getTime();
  let onlineMs = 0;

  for (const log of inWindow) {
    const t = log.at.getTime();
    if (state) {
      onlineMs += t - cursor;
    }
    state = log.online;
    cursor = t;
  }
  // Son segment: son kayıttan şimdiye kadar geçen süre
  if (state) {
    onlineMs += now - cursor;
  }

  const pct = (onlineMs / WINDOW_MS) * 100;
  return Math.round(pct * 10) / 10;
}

// Son 24 saatte cihazların çevrimiçi kaldığı süre yüzdesi (0-100, 1 ondalık basamak)
export async function computeUptimes24h(
  devices: readonly DeviceUptimeInput[],
): Promise<Map<string, number>> {
  const currentStatusByDevice = new Map(
    devices.map(({ deviceId, nowOnline }) => [deviceId, nowOnline]),
  );
  if (currentStatusByDevice.size === 0) {
    return new Map();
  }

  const now = Date.now();
  const windowStart = new Date(now - WINDOW_MS);
  const collection = db.collection<DeviceStatusLogDoc>(COLLECTION);
  const [grouped] = await collection
    .aggregate<UptimeAggregationResult>([
      {
        $match: { deviceId: { $in: [...currentStatusByDevice.keys()] } },
      },
      {
        $facet: {
          inWindow: [
            { $match: { at: { $gte: windowStart } } },
            { $sort: { deviceId: 1, at: 1 } },
            {
              $group: {
                _id: "$deviceId",
                logs: {
                  $push: {
                    deviceId: "$deviceId",
                    online: "$online",
                    at: "$at",
                  },
                },
              },
            },
          ],
          before: [
            { $match: { at: { $lt: windowStart } } },
            { $sort: { deviceId: 1, at: -1 } },
            {
              $group: {
                _id: "$deviceId",
                log: {
                  $first: {
                    deviceId: "$deviceId",
                    online: "$online",
                    at: "$at",
                  },
                },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const inWindowByDevice = new Map(
    grouped?.inWindow.map(({ _id, logs }) => [_id, logs]),
  );
  const beforeByDevice = new Map(
    grouped?.before.map(({ _id, log }) => [_id, log]),
  );
  const uptimes = new Map<string, number>();

  for (const [deviceId, nowOnline] of currentStatusByDevice) {
    uptimes.set(
      deviceId,
      calculateUptime24h(
        inWindowByDevice.get(deviceId) ?? [],
        beforeByDevice.get(deviceId),
        nowOnline,
        now,
        windowStart,
      ),
    );
  }

  return uptimes;
}

// Tek cihaz kullanan çağrılar toplu sorgu ve hesaplama mantığını paylaşır.
export async function computeUptime24h(
  deviceId: string,
  nowOnline: boolean,
): Promise<number> {
  const uptimes = await computeUptimes24h([{ deviceId, nowOnline }]);
  return uptimes.get(deviceId)!;
}
