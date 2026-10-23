export type OccupancyTone = "neutral" | "success" | "warning" | "error";
export type OccupancyLabel = "Unknown" | "Busy" | "Moderate" | "Quiet";

export interface OccupancyLevel {
  /** Whole percentage clamped to 0–100; null when capacity is unknown. */
  percent: number | null;
  tone: OccupancyTone;
  label: OccupancyLabel;
}

/** Busy above 90 %, moderate from 70 %, quiet below; unknown without a ratio. */
export function occupancyLevel(
  ratio: number | null | undefined,
): OccupancyLevel {
  if (ratio == null || !Number.isFinite(ratio)) {
    return { percent: null, tone: "neutral", label: "Unknown" };
  }
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  if (percent > 90) return { percent, tone: "error", label: "Busy" };
  if (percent >= 70) return { percent, tone: "warning", label: "Moderate" };
  return { percent, tone: "success", label: "Quiet" };
}
