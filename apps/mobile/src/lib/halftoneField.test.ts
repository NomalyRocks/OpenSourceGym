import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HALFTONE_MAX_DELAY_MS,
  HALFTONE_RADIUS_FACTOR,
  buildHalftoneField,
  halftoneGrid,
  mulberry32,
} from "./halftoneField";

const CELL = 13;
const { cols, rows } = halftoneGrid(390, 844, CELL);

describe("mulberry32", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = a();
      assert.equal(value, b());
      assert.ok(value >= 0 && value < 1);
    }
  });
});

describe("halftoneGrid", () => {
  it("covers the surface with whole cells", () => {
    assert.deepEqual(halftoneGrid(390, 844, 13), { cols: 30, rows: 65 });
    assert.deepEqual(halftoneGrid(1, 1, 13), { cols: 1, rows: 1 });
  });
});

describe("buildHalftoneField", () => {
  const dots = buildHalftoneField(cols, rows, CELL);

  it("is deterministic for a given grid and seed", () => {
    assert.deepEqual(dots, buildHalftoneField(cols, rows, CELL));
    assert.notDeepEqual(dots, buildHalftoneField(cols, rows, CELL, 8));
  });

  it("yields a dense field of visible dots", () => {
    assert.ok(dots.length > 800 && dots.length < cols * rows);
  });

  it("keeps radii within the visible range and the cell", () => {
    for (const dot of dots) {
      assert.ok(dot.radius >= 1.2);
      assert.ok(dot.radius <= CELL * HALFTONE_RADIUS_FACTOR);
    }
  });

  it("keeps delays within the pop-in window", () => {
    for (const dot of dots) {
      assert.ok(dot.delay >= 0 && dot.delay <= HALFTONE_MAX_DELAY_MS);
    }
    assert.ok(Math.min(...dots.map((d) => d.delay)) < 60);
    assert.ok(Math.max(...dots.map((d) => d.delay)) > 440);
  });

  it("places every dot inside the grid", () => {
    for (const dot of dots) {
      assert.ok(dot.x > 0 && dot.x < cols * CELL);
      assert.ok(dot.y > 0 && dot.y < rows * CELL);
    }
  });

  it("makes sky rows larger on average than mountain rows", () => {
    // Dropped dots count as radius 0, so density counts as well as size.
    const meanRowRadius = (from: number, to: number) => {
      let sum = 0;
      for (const dot of dots) {
        const row = Math.floor(dot.y / CELL);
        if (row >= from && row < to) sum += dot.radius;
      }
      return sum / ((to - from) * cols);
    };
    const sky = meanRowRadius(0, Math.floor(rows * 0.1));
    const mountain = meanRowRadius(Math.floor(rows * 0.7), rows);
    assert.ok(sky > mountain * 1.3, `sky ${sky} vs mountain ${mountain}`);
  });
});
