/**
 * Drawing constants and helpers shared by the splash intro and the auth
 * screens' halftone band, so both render the same dots, wordmark and glow.
 */
import { Skia, type SkFont, type SkPath } from "@shopify/react-native-skia";
import type { HalftoneDot } from "../lib/halftoneField";

export const BRAND_BLUE = "#0055FF";
export const WORDMARK = "OpenGym";

/** Dot grid pitch in dp. */
export const CELL = 13;
/** Dots smaller than this radius (dp) are not drawn. */
export const MIN_DRAW_RADIUS = 0.25;

/** Splash wordmark width as a fraction of the screen width. */
export const WORDMARK_WIDTH_RATIO = 0.78;
/** The hero sits the title slightly above the centre (40 of 900 px). */
export const WORDMARK_LIFT_RATIO = 0.044;
/** Blur sigma relative to the font size (hero: 30 px blur on a 210 px font). */
export const GLOW_SIGMA_RATIO = 0.14;
/** Wordmark width on the auth band, as a fraction of the screen width. */
export const BAND_WORDMARK_WIDTH_RATIO = 0.5;

export interface WordmarkLayout {
  font: SkFont;
  /** Baseline origin that centres the text horizontally on the screen. */
  x: number;
  y: number;
  centerY: number;
  /** Font size in dp. */
  size: number;
  sigma: number;
}

/**
 * Sizes the wordmark to `widthRatio` of `width` and centres it on `centerY`.
 * `baseFont` is the same face loaded at 100 pt, used only for measuring.
 */
export function layoutWordmark(
  baseFont: SkFont | null,
  width: number,
  centerY: number,
  widthRatio: number,
): WordmarkLayout | null {
  const typeface = baseFont?.getTypeface();
  if (!baseFont || !typeface) return null;
  const baseWidth = baseFont.measureText(WORDMARK).width || 1;
  const size = (100 * width * widthRatio) / baseWidth;
  const font = Skia.Font(typeface, size);
  const bounds = font.measureText(WORDMARK);
  return {
    font,
    x: (width - bounds.width) / 2 - bounds.x,
    y: centerY - (bounds.y + bounds.height / 2),
    centerY,
    size,
    sigma: size * GLOW_SIGMA_RATIO,
  };
}

/** Vertical centre of the wordmark inside an auth band. */
export function bandWordmarkCenterY(topInset: number, bandHeight: number) {
  return topInset + (bandHeight - topInset) / 2;
}

/** One path holding every dot at its final radius. */
export function buildDotPath(dots: readonly HalftoneDot[]): SkPath {
  const path = Skia.Path.Make();
  for (const dot of dots) {
    if (dot.radius > MIN_DRAW_RADIUS) path.addCircle(dot.x, dot.y, dot.radius);
  }
  return path;
}
