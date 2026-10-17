import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distanceMeters } from "./geo.js";
import {
  IMPOSSIBLE_TRAVEL_KMH,
  impliedSpeedKmh,
  isImpossibleTravel,
} from "./travel.js";

const ISTANBUL = { lat: 41.0, lng: 29.0 };
const ANKARA = { lat: 39.9, lng: 32.8 };
const MINUTE = 60_000;

describe("impliedSpeedKmh", () => {
  it("divides distance by elapsed time", () => {
    assert.equal(impliedSpeedKmh(100_000, 3_600_000), 100);
  });

  it("never divides by zero", () => {
    assert.ok(Number.isFinite(impliedSpeedKmh(1000, 0)));
  });
});

describe("isImpossibleTravel", () => {
  it("flags a 350 km hop in ten minutes", () => {
    const result = isImpossibleTravel(
      ISTANBUL,
      ANKARA,
      distanceMeters,
      10 * MINUTE,
    );
    assert.equal(result.impossible, true);
    assert.ok((result.speedKmh ?? 0) > IMPOSSIBLE_TRAVEL_KMH);
  });

  it("accepts the same hop after four hours", () => {
    const result = isImpossibleTravel(
      ISTANBUL,
      ANKARA,
      distanceMeters,
      4 * 60 * MINUTE,
    );
    assert.equal(result.impossible, false);
  });

  it("gives no verdict when a gym location is unknown", () => {
    assert.deepEqual(isImpossibleTravel(null, ANKARA, distanceMeters, 1), {
      impossible: false,
      speedKmh: null,
      distanceM: null,
    });
  });
});
