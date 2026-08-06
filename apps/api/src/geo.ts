const EARTH_RADIUS_METERS = 6371000;

/**
 * Bounds for the gym geofence radius.
 *
 * The floor is generous on purpose: phone GPS varies by tens of metres between
 * handsets and degrades near a building, so a tight radius rejects members who
 * are standing at the turnstile. The ceiling keeps the check meaningful — the
 * geofence is what stops a photographed turnstile QR from being replayed from
 * elsewhere, and an unbounded radius silently turns it off.
 */
export const GEOFENCE_RADIUS_M_MIN = 100;
export const GEOFENCE_RADIUS_M_MAX = 5000;
export const GEOFENCE_RADIUS_M_DEFAULT = 400;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Straight-line distance between two coordinates using the Haversine formula (meters)
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface GymLocation {
  lat: number;
  lng: number;
  radiusM: number;
}

export type GeofenceVerdict =
  | "OK"
  | "LOCATION_REQUIRED"
  | "OUT_OF_RANGE"
  | "GYM_LOCATION_UNSET";

export interface GeofenceEvaluation {
  verdict: GeofenceVerdict;
  /** Whole metres from the gym, or null when the distance could not be computed. */
  distanceM: number | null;
}

/**
 * Decides whether a scan is close enough to the gym. Pure so the rules can be
 * tested without Mongo; {@link module:routes/me} supplies the configured
 * location.
 *
 * An unconfigured gym location is a REJECTION, not a skip. The turnstile QR is
 * static and physically printed, so anyone who photographs it can replay it
 * from anywhere — location is the only thing tying a scan to the building, and
 * treating "unconfigured" as "allowed" made the weakest configuration the most
 * permissive one.
 */
export function evaluateGeofence(
  location: GymLocation | null | undefined,
  lat: number | undefined,
  lng: number | undefined,
): GeofenceEvaluation {
  if (!location) {
    return { verdict: "GYM_LOCATION_UNSET", distanceM: null };
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    return { verdict: "LOCATION_REQUIRED", distanceM: null };
  }
  const distanceM = Math.round(
    distanceMeters(lat, lng, location.lat, location.lng),
  );
  return {
    // Inclusive: a member standing exactly on the configured boundary is at the
    // gym, and GPS noise around the edge should not decide entry.
    verdict: distanceM > effectiveRadiusM(location.radiusM) ? "OUT_OF_RANGE" : "OK",
    distanceM,
  };
}

/**
 * Clamps a stored radius into the supported range.
 *
 * The bounds are enforced when settings are written, which only constrains
 * FUTURE writes: an installation configured before the bounds existed can be
 * carrying an arbitrary value, and a 100 km radius silently disables the whole
 * check. Clamping on read makes the ceiling hold for existing data too, without
 * a migration.
 */
function effectiveRadiusM(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return GEOFENCE_RADIUS_M_DEFAULT;
  return Math.min(
    Math.max(radiusM, GEOFENCE_RADIUS_M_MIN),
    GEOFENCE_RADIUS_M_MAX,
  );
}
