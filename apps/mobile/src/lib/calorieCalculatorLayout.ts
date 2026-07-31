export interface IntroArtworkViewport {
  width: number;
  height: number;
  fontScale: number;
}

/**
 * Giriş illüstrasyonunu küçük ekranlarda başlık ilk görünümde kalacak şekilde
 * sınırlar. ScrollView, yatay ekran ve çok büyük yazı için emniyet olmaya devam
 * eder; normal telefonlarda akış kaydırmaya ihtiyaç duymaz.
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
