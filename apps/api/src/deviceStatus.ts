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

// Device connection status history (KPI-4: percentage online in the last 24 hours).
// Fire-and-forget: does not block the API/Gateway flow; errors go to the console.
export function logDeviceStatus(deviceId: string, online: boolean): void {
  db.collection<DeviceStatusLogDoc>(COLLECTION)
    .insertOne({ deviceId, online, at: new Date() })
    .catch((err) => {
      console.error("device status record could not be written:", err);
    });
}

// Recovery for devices left as "online: true" after a server crash/restart: if
// a device's latest record is online, append a "false" record (otherwise uptime
// calculation would consider the device online forever).
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
    console.error("initial device status history sweep failed:", err);
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
      // No records: treat the device's current state as constant for the window
      return nowOnline ? 100 : 0;
    }
    return before.online ? 100 : 0;
  }

  const firstInWindow = inWindow[0]!;
  // State at the start of the window: use a preceding record if present;
  // otherwise, because the first in-window record is itself a state CHANGE,
  // assume the preceding state was its inverse
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
  // Final segment: time from the last record until now
  if (state) {
    onlineMs += now - cursor;
  }

  const pct = (onlineMs / WINDOW_MS) * 100;
  return Math.round(pct * 10) / 10;
}

// Percentage of time devices were online in the last 24 hours (0–100, one decimal)
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

// Single-device calls share the batch query and calculation logic.
export async function computeUptime24h(
  deviceId: string,
  nowOnline: boolean,
): Promise<number> {
  const uptimes = await computeUptimes24h([{ deviceId, nowOnline }]);
  return uptimes.get(deviceId)!;
}
