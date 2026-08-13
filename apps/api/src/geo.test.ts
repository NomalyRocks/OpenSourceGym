import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateGeofence,
  GEOFENCE_RADIUS_M_DEFAULT,
  GEOFENCE_RADIUS_M_MAX,
  GEOFENCE_RADIUS_M_MIN,
} from "./geo.js";

// Two points roughly 300 m apart in Istanbul.
const GYM = { lat: 41.0082, lng: 28.9784, radiusM: 400 };
const NEARBY = { lat: 41.0082, lng: 28.982 };
// ~40 m away: inside the 100 m floor, so it exercises clamping from below.
const AT_THE_GATE = { lat: 41.0082, lng: 28.97887 };
const FAR_AWAY = { lat: 39.9334, lng: 32.8597 }; // Ankara

describe("evaluateGeofence", () => {
  it("rejects the scan when the operator has configured no gym location", () => {
    // The turnstile QR is public by design, so an unconfigured location must
    // fail closed rather than skip the check.
    assert.deepEqual(evaluateGeofence(null, NEARBY.lat, NEARBY.lng), {
      verdict: "GYM_LOCATION_UNSET",
      distanceM: null,
    });
    assert.equal(
      evaluateGeofence(undefined, NEARBY.lat, NEARBY.lng).verdict,
      "GYM_LOCATION_UNSET",
    );
  });

  it("distinguishes a missing phone position from a missing gym location", () => {
    // The clients branch on this: one is the member's problem, the other is the
    // operator's.
    assert.equal(
      evaluateGeofence(GYM, undefined, undefined).verdict,
      "LOCATION_REQUIRED",
    );
    assert.equal(
      evaluateGeofence(GYM, NEARBY.lat, undefined).verdict,
      "LOCATION_REQUIRED",
    );
    assert.equal(
      evaluateGeofence(GYM, undefined, NEARBY.lng).verdict,
      "LOCATION_REQUIRED",
    );
  });

  it("allows a scan inside the radius and reports the distance", () => {
    const result = evaluateGeofence(GYM, NEARBY.lat, NEARBY.lng);
    assert.equal(result.verdict, "OK");
    assert.ok(
      result.distanceM !== null &&
        result.distanceM > 0 &&
        result.distanceM < GYM.radiusM,
      `expected a positive distance inside the radius, got ${result.distanceM}`,
    );
  });

  it("allows a scan exactly on the boundary", () => {
    // GPS noise at the edge must not decide entry, so the comparison is inclusive.
    const { distanceM } = evaluateGeofence(GYM, NEARBY.lat, NEARBY.lng);
    assert.ok(distanceM !== null);
    const tight = { ...GYM, radiusM: distanceM };
    assert.equal(evaluateGeofence(tight, NEARBY.lat, NEARBY.lng).verdict, "OK");
  });

  it("rejects a scan one metre beyond the radius", () => {
    const { distanceM } = evaluateGeofence(GYM, NEARBY.lat, NEARBY.lng);
    assert.ok(distanceM !== null);
    const tighter = { ...GYM, radiusM: distanceM - 1 };
    assert.equal(
      evaluateGeofence(tighter, NEARBY.lat, NEARBY.lng).verdict,
      "OUT_OF_RANGE",
    );
  });

  it("reports the distance on rejection so the scan can be reviewed later", () => {
    const result = evaluateGeofence(GYM, FAR_AWAY.lat, FAR_AWAY.lng);
    assert.equal(result.verdict, "OUT_OF_RANGE");
    // Istanbul to Ankara is roughly 350 km.
    assert.ok(
      result.distanceM !== null && result.distanceM > 300_000,
      `expected a long distance, got ${result.distanceM}`,
    );
  });

  it("returns whole metres", () => {
    const { distanceM } = evaluateGeofence(GYM, NEARBY.lat, NEARBY.lng);
    assert.ok(distanceM !== null && Number.isInteger(distanceM));
  });

  it("clamps a stored radius above the ceiling", () => {
    // The write-time bounds only constrain future writes. An installation
    // configured before they existed can carry a radius that disables the check
    // entirely, so the ceiling has to hold on read as well.
    const { distanceM } = evaluateGeofence(GYM, FAR_AWAY.lat, FAR_AWAY.lng);
    assert.ok(distanceM !== null && distanceM > GEOFENCE_RADIUS_M_MAX);
    assert.equal(
      evaluateGeofence({ ...GYM, radiusM: 100_000 }, FAR_AWAY.lat, FAR_AWAY.lng)
        .verdict,
      "OUT_OF_RANGE",
    );
  });

  it("clamps a stored radius below the floor", () => {
    // Symmetrically, a 5 m radius left over from an earlier configuration would
    // deny a member standing at the turnstile, whom ordinary GPS error already
    // places tens of metres away.
    const { distanceM } = evaluateGeofence(
      GYM,
      AT_THE_GATE.lat,
      AT_THE_GATE.lng,
    );
    assert.ok(
      distanceM !== null && distanceM > 5 && distanceM < GEOFENCE_RADIUS_M_MIN,
      `expected a distance inside the floor, got ${distanceM}`,
    );
    assert.equal(
      evaluateGeofence({ ...GYM, radiusM: 5 }, AT_THE_GATE.lat, AT_THE_GATE.lng)
        .verdict,
      "OK",
    );
  });

  it("falls back to the default for a non-finite stored radius", () => {
    assert.equal(
      evaluateGeofence({ ...GYM, radiusM: Number.NaN }, NEARBY.lat, NEARBY.lng)
        .verdict,
      "OK",
    );
  });

  it("keeps the configurable radius bounds coherent", () => {
    assert.ok(GEOFENCE_RADIUS_M_MIN < GEOFENCE_RADIUS_M_DEFAULT);
    assert.ok(GEOFENCE_RADIUS_M_DEFAULT < GEOFENCE_RADIUS_M_MAX);
    // The floor must tolerate ordinary phone GPS error, which reaches tens of metres.
    assert.ok(GEOFENCE_RADIUS_M_MIN >= 100);
  });
});
