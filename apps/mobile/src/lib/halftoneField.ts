/**
 * Halftone dot field for the splash intro.
 *
 * A TypeScript port of the brightness field in `docs/assets/hero.py` (the
 * README hero): light sky that gets denser towards the top, two darker
 * mountain ridges whose faces turned to the light are brighter, plus rock
 * noise and a little grain. The ridges and noise are drawn from a seeded PRNG,
 * so the same grid always yields the same picture.
 *
 * Pure and dependency-free so it can be unit-tested under Node.
 */

export interface HalftoneDot {
  /** Centre, in the same unit as `cell` (dp). */
  x: number;
  y: number;
  /** Final dot radius, in the same unit as `cell`. */
  radius: number;
  /** Pop-in delay in ms, within `[0, HALFTONE_MAX_DELAY_MS]`. */
  delay: number;
}

export const HALFTONE_MAX_DELAY_MS = 520;
/** Dots whose radius is below this many dp are not worth drawing (hero: 1.2). */
const MIN_RADIUS = 1.2;
/** Largest radius as a fraction of the cell size (hero: 0.46). */
export const HALFTONE_RADIUS_FACTOR = 0.46;
const DEFAULT_SEED = 7;

/** Small, fast, well-distributed seeded PRNG returning floats in `[0, 1)`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

/** `np.interp` for equally spaced integer sample points, clamped at the ends. */
function interp(position: number, samples: number[]): number {
  const last = samples.length - 1;
  const i = Math.min(Math.max(Math.floor(position), 0), last - 1);
  const t = Math.min(Math.max(position - i, 0), 1);
  return (samples[i] ?? 0) * (1 - t) + (samples[i + 1] ?? 0) * t;
}

/** Layered random ridge line, `n` points, heights unnormalised. */
function ridge(
  rng: Rng,
  n: number,
  octaves: number,
  base: number,
  amp: number,
): number[] {
  const y = new Array<number>(n).fill(base);
  for (let o = 0; o < octaves; o++) {
    const f = 2 ** o;
    const points = Array.from({ length: f + 2 }, rng);
    const scale = amp / 1.6 ** o;
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0;
      y[i] = (y[i] ?? 0) + interp(x * (f + 1), points) * scale;
    }
  }
  return y;
}

/** Hanning-window moving average with edge padding (same length as input). */
function smooth(a: number[], k: number): number[] {
  const w = Array.from(
    { length: k },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (k - 1)),
  );
  const total = w.reduce((s, v) => s + v, 0);
  const n = a.length;
  const padded = (i: number) => a[Math.min(Math.max(i - k, 0), n - 1)] ?? 0;
  const half = Math.floor(k / 2);
  return Array.from({ length: n }, (_, i) => {
    let sum = 0;
    for (let j = 0; j < k; j++) {
      sum += padded(i + k + j - half) * (w[j] ?? 0);
    }
    return sum / total;
  });
}

/** Linear rescale of `a` into `[lo, hi]`; a flat input maps to `lo`. */
function fit(a: number[], lo: number, hi: number): number[] {
  const min = Math.min(...a);
  const max = Math.max(...a);
  const span = max - min || 1;
  return a.map((v) => lo + ((v - min) / span) * (hi - lo));
}

/** Value noise: a coarse random grid bilinearly upsampled to `cols` x `rows`. */
function noise2d(
  rng: Rng,
  cols: number,
  rows: number,
  scale: number,
): number[][] {
  const sh = Math.floor(rows / scale) + 2;
  const sw = Math.floor(cols / scale) + 2;
  const small = Array.from({ length: sh }, () =>
    Array.from({ length: sw }, rng),
  );
  const at = (r: number, c: number) =>
    small[Math.min(Math.max(r, 0), sh - 1)]?.[
      Math.min(Math.max(c, 0), sw - 1)
    ] ?? 0;
  return Array.from({ length: rows }, (_, r) => {
    const sy = Math.max(((r + 0.5) * sh) / rows - 0.5, 0);
    const r0 = Math.floor(sy);
    const fy = sy - r0;
    return Array.from({ length: cols }, (_, c) => {
      const sx = Math.max(((c + 0.5) * sw) / cols - 0.5, 0);
      const c0 = Math.floor(sx);
      const fx = sx - c0;
      const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx;
      const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    });
  });
}

/** `np.gradient` with unit spacing: central differences, one-sided at the ends. */
function gradient(a: number[]): number[] {
  const n = a.length;
  return a.map((v, i) => {
    if (n < 2) return 0;
    if (i === 0) return (a[1] ?? v) - v;
    if (i === n - 1) return v - (a[n - 2] ?? v);
    return ((a[i + 1] ?? v) - (a[i - 1] ?? v)) / 2;
  });
}

/** Standard-normal sample via Box-Muller. */
function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Number of grid columns/rows needed to cover a surface with square cells. */
export function halftoneGrid(
  width: number,
  height: number,
  cell: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(width / cell)),
    rows: Math.max(1, Math.ceil(height / cell)),
  };
}

/**
 * Builds the dot list for a `cols` x `rows` grid of square `cell`-sized cells.
 *
 * Row 0 is the top (sky), the last row is the bottom (foreground ridge).
 * Dots below the visibility threshold are dropped, as in the hero.
 */
export function buildHalftoneField(
  cols: number,
  rows: number,
  cell: number,
  seed: number = DEFAULT_SEED,
): HalftoneDot[] {
  const rng = mulberry32(seed);

  // Heights are fractions of the frame measured from the bottom.
  const far = fit(smooth(ridge(rng, cols, 5, 0, 1), 5), 0.42, 0.85);
  const near = fit(smooth(ridge(rng, cols, 5, 0, 1), 7), 0.12, 0.42);
  const slopeFar = gradient(far).map((s) => s * cols);
  const slopeNear = gradient(near).map((s) => s * cols);
  const rockA = noise2d(rng, cols, rows, 4);
  const rockB = noise2d(rng, cols, rows, 2);
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

  const field: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const h = 1 - r / rows;
    const rockRow = Array.from(
      { length: cols },
      (_, c) => (rockA[r]?.[c] ?? 0) * 0.6 + (rockB[r]?.[c] ?? 0) * 0.4,
    );
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      // Sky: dense dots, denser at the top.
      let v = 0.62 + 0.25 * h;
      const farH = far[c] ?? 0;
      const nearH = near[c] ?? 0;
      if (h < farH) {
        const depth = clamp01((farH - h) / 0.35);
        // Faces rising left to right catch the light; light fades with depth.
        v =
          0.18 +
          0.5 * clamp01(Math.tanh((slopeFar[c] ?? 0) * 0.8)) * (1 - depth) +
          0.35 * (rockRow[c] ?? 0) * (1 - 0.5 * depth);
      }
      if (h < nearH) {
        const depth = clamp01((nearH - h) / 0.25);
        v =
          0.08 +
          0.45 * clamp01(Math.tanh(-(slopeNear[c] ?? 0) * 0.8)) * (1 - depth) +
          0.3 * (rockRow[cols - 1 - c] ?? 0);
      }
      row.push(v);
    }
    field.push(row);
  }

  // Grain, then clip. Separate streams keep the picture independent of delays.
  const grain = mulberry32(seed + 101);
  const delays = mulberry32(seed + 202);
  const dots: HalftoneDot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = clamp01((field[r]?.[c] ?? 0) + gaussian(grain) * 0.05);
      const radius = v * cell * HALFTONE_RADIUS_FACTOR;
      // Always consume the stream so a dropped dot does not shift the others.
      const jitter = delays();
      if (radius < MIN_RADIUS) continue;
      // Mostly random, with a slight top-to-bottom bias.
      const delay = Math.round(
        HALFTONE_MAX_DELAY_MS * (0.8 * jitter + 0.2 * (r / rows)),
      );
      dots.push({
        x: c * cell + cell / 2,
        y: r * cell + cell / 2,
        radius,
        delay,
      });
    }
  }
  return dots;
}
