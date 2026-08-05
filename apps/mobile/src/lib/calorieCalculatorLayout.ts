export interface IntroArtworkViewport {
  width: number;
  height: number;
  fontScale: number;
}

/**
 * Constrains the intro illustration on small screens so the heading remains in
 * the initial viewport. ScrollView remains a safeguard for landscape and very
 * large text; the flow does not require scrolling on typical phones.
 */
export function getCalorieIntroArtworkSize({
  width,
  height,
  fontScale,
}: IntroArtworkViewport): number {
  const heightLimit =
    height < 620 || fontScale > 1.3
      ? 156
      : height < 760 || fontScale > 1.1
        ? 184
        : 228;
  const widthLimit = Math.max(96, width - 64);

  return Math.round(Math.min(heightLimit, widthLimit));
}
