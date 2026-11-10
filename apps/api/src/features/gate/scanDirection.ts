import type { DeviceDirection, DeviceMode } from "@opengym/shared";

/** Accepts legacy QRs only for single-direction devices and sided QRs only for "both". */
export function resolveScanDirection(
  mode: DeviceMode,
  side: DeviceDirection | null,
): DeviceDirection | null {
  if (mode === "both") return side;
  return side === null ? mode : null;
}
