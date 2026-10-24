import {
  Blur,
  Canvas,
  Fill,
  Group,
  Path,
  Text as SkiaText,
  useFont,
} from "@shopify/react-native-skia";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { buildHalftoneField, halftoneGrid } from "../lib/halftoneField";
import {
  BAND_WORDMARK_WIDTH_RATIO,
  BRAND_BLUE,
  CELL,
  WORDMARK,
  bandWordmarkCenterY,
  buildDotPath,
  layoutWordmark,
  type WordmarkLayout,
} from "../ui/halftone";
import openGymFont from "../../assets/fonts/OpenGym.otf";

/**
 * White wordmark in a blue glow. Three blurred passes stand in for the hero's
 * alpha boost, so the halo is solid enough to clear the dots behind it.
 */
export function SkiaWordmark({ layout }: { layout: WordmarkLayout }) {
  return (
    <>
      {[0, 1, 2].map((pass) => (
        <SkiaText
          key={pass}
          text={WORDMARK}
          font={layout.font}
          x={layout.x}
          y={layout.y}
          color={BRAND_BLUE}
        >
          <Blur blur={layout.sigma} />
        </SkiaText>
      ))}
      <SkiaText
        text={WORDMARK}
        font={layout.font}
        x={layout.x}
        y={layout.y}
        color="white"
      />
    </>
  );
}

/**
 * Static brand band for the auth screens: the splash's halftone field (same
 * seed and cell size) over `#0055FF`, with the wordmark. `topInset` keeps the
 * wordmark clear of the status bar.
 */
export function HalftoneBand({
  height,
  topInset = 0,
  showWordmark = true,
  seed,
  width: widthProp,
}: {
  height: number;
  topInset?: number;
  showWordmark?: boolean;
  /** Field seed; omitted keeps the auth/splash landscape. */
  seed?: number;
  /** Band width in dp; defaults to the window width. */
  width?: number;
}) {
  const window = useWindowDimensions();
  const width = widthProp ?? window.width;
  const dotsPath = useMemo(() => {
    const { cols, rows } = halftoneGrid(width, height, CELL);
    return buildDotPath(buildHalftoneField(cols, rows, CELL, seed));
  }, [width, height, seed]);

  const baseFont = useFont(openGymFont, 100);
  const wordmark = useMemo(
    () =>
      layoutWordmark(
        baseFont,
        width,
        bandWordmarkCenterY(topInset, height),
        BAND_WORDMARK_WIDTH_RATIO,
      ),
    [baseFont, width, height, topInset],
  );

  return (
    <Canvas
      style={{ width, height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Fill color={BRAND_BLUE} />
      <Path path={dotsPath} color="white" />
      {showWordmark && wordmark ? (
        <Group>
          <SkiaWordmark layout={wordmark} />
        </Group>
      ) : null}
    </Canvas>
  );
}
