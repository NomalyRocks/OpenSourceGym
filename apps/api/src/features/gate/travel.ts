/**
 * Implied travel speed above which entering gym B while still recorded inside
 * gym A is recorded as a sharing signal (resolved design question 2).
 */
export const IMPOSSIBLE_TRAVEL_KMH = 120;

/** Elapsed times below this are treated as this, so a zero gap cannot divide by zero. */
const MIN_ELAPSED_MS = 1000;

/** Speed (km/h) needed to cover `distanceM` in `elapsedMs`. */
export function impliedSpeedKmh(distanceM: number, elapsedMs: number): number {
  const hours = Math.max(elapsedMs, MIN_ELAPSED_MS) / 3_600_000;
  return distanceM / 1000 / hours;
}

/**
 * Whether the hop between two gym locations is physically implausible. Returns
 * false when either location is unknown — no signal can be derived then.
 */
export function isImpossibleTravel(
  from: { lat: number; lng: number } | null,
  to: { lat: number; lng: number } | null,
  distanceM: (lat1: number, lng1: number, lat2: number, lng2: number) => number,
  elapsedMs: number,
): { impossible: boolean; speedKmh: number | null; distanceM: number | null } {
  if (!from || !to)
    return { impossible: false, speedKmh: null, distanceM: null };
  const metres = distanceM(from.lat, from.lng, to.lat, to.lng);
  const speedKmh = impliedSpeedKmh(metres, elapsedMs);
  return {
    impossible: speedKmh > IMPOSSIBLE_TRAVEL_KMH,
    speedKmh,
    distanceM: metres,
  };
}
