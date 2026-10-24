import {
  Canvas,
  Fill,
  Group,
  Path,
  Skia,
  useFont,
} from "@shopify/react-native-skia";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildHalftoneField, halftoneGrid } from "../lib/halftoneField";
import { SkiaWordmark } from "../components/HalftoneBand";
import { useThemedStyles, type Theme } from "../theme";
import { useReducedMotion } from "../ui";
import {
  BAND_WORDMARK_WIDTH_RATIO,
  BRAND_BLUE,
  CELL,
  MIN_DRAW_RADIUS,
  WORDMARK_LIFT_RATIO,
  WORDMARK_WIDTH_RATIO,
  bandWordmarkCenterY,
  layoutWordmark,
} from "../ui/halftone";
import openGymFont from "../../assets/fonts/OpenGym.otf";

/** Each dot grows 0 → full radius over this long, with a small overshoot. */
const DOT_POP_MS = 150;
/** Last dot starts popping at 520 ms (see `HALFTONE_MAX_DELAY_MS`). */
const ENTER_MS = 520 + DOT_POP_MS;
const BACK_C1 = 1.2;
const BACK_C3 = BACK_C1 + 1;

const MARK_DELAY_MS = 550;
const MARK_MS = 400;

/** Earliest exit, so a fast boot still lets the brand land. */
const MIN_VISIBLE_MS = 1300;
const SLOW_BOOT_MS = 2500;

/** Exit: centre-out shrink wave, wordmark rise, then the blue clears. */
const EXIT_WAVE_MS = 300;
const EXIT_DOT_MS = 250;
const EXIT_MARK_MS = 250;
const EXIT_MS = EXIT_WAVE_MS + EXIT_DOT_MS;
const EXIT_RISE = 16;
const REDUCED_MIN_VISIBLE_MS = 600;
const REDUCED_FADE_MS = 150;

/**
 * Exit into the auth band: the blue clips up to the band height while the
 * wordmark travels to the band's wordmark spot, the dots crossfade into the
 * identical band underneath, then the wordmark fades over its twin.
 */
const BAND_CLIP_MS = 450;
const BAND_DOT_FADE_DELAY_MS = 250;
const BAND_DOT_FADE_MS = 200;
const BAND_MARK_FADE_MS = 100;
const EASE_IN_OUT_POINTS = [0.65, 0, 0.35, 1] as const;

/*
 * The same cubic-bezier values as `easing` in `ui/motion.ts`. That module
 * builds them with React Native's `Easing`, which cannot run on the UI thread,
 * so the Reanimated equivalent is built here from the same numbers.
 */
const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
const EASE_IN = Easing.bezier(0.55, 0, 1, 0.45);
const EASE_IN_OUT = Easing.bezier(...EASE_IN_OUT_POINTS);

/** Number of values stored per dot in the flat array shared with the UI thread. */
const STRIDE = 5;

/**
 * Splash screen: a halftone dot field pops in over the brand blue, the
 * OpenGym wordmark lands in a glow that clears the dots (like the README
 * hero), and once the app is ready the dots shrink away in a wave from the
 * centre while the wordmark rises and fades.
 *
 * This is the one deliberate decorative-motion exception to the rule in
 * `ui/motion.ts`: it is a brand moment, shown once per cold start. It never
 * delays the app beyond `MIN_VISIBLE_MS` once `ready`, tapping after `ready`
 * skips ahead, and with reduced motion it is a static frame with a short
 * crossfade out.
 *
 * Everything is drawn in one Skia canvas; all animation state lives in shared
 * values so frames are produced on the UI thread.
 */
export function Splash({
  ready,
  onFinish,
  exitTo,
  bandHeight,
}: {
  ready: boolean;
  onFinish: () => void;
  /** `"band"` morphs into the auth screens' halftone band; `"fade"` clears. */
  exitTo: "fade" | "band";
  /** Height of the band the splash morphs into (used when `exitTo` is band). */
  bandHeight: number;
}) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(splashStyles);
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();

  const [minElapsed, setMinElapsed] = useState(false);
  const [slow, setSlow] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const exiting = useRef(false);
  const onFinishRef = useRef(onFinish);

  /** Milliseconds into the dot pop-in. */
  const enter = useSharedValue(0);
  /** Wordmark reveal, 0 → 1. */
  const mark = useSharedValue(0);
  /** Milliseconds into the exit wave. */
  const exit = useSharedValue(0);
  /** Wordmark exit, 0 → 1. */
  const markExit = useSharedValue(0);
  /** Band exit: clip height and wordmark travel, 0 → 1. */
  const bandClip = useSharedValue(0);
  /** Band exit: blue fill and dots crossfade out, 0 → 1. */
  const bandFade = useSharedValue(0);
  /** Band exit: wordmark fade out, 0 → 1. */
  const bandMarkFade = useSharedValue(0);
  /** Whole-splash fade out, 0 → 1. */
  const fade = useSharedValue(0);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  // Flat [x, y, radius, delay, exitDelay] per dot so it can be captured by
  // worklets as plain numbers.
  const dots = useMemo(() => {
    const { cols, rows } = halftoneGrid(width, height, CELL);
    const field = buildHalftoneField(cols, rows, CELL);
    const cx = width / 2;
    const cy = height / 2;
    const maxDistance = Math.hypot(cx, cy) || 1;
    const flat: number[] = [];
    for (const dot of field) {
      const distance = Math.hypot(dot.x - cx, dot.y - cy) / maxDistance;
      flat.push(dot.x, dot.y, dot.radius, dot.delay, distance * EXIT_WAVE_MS);
    }
    return flat;
  }, [width, height]);

  const baseFont = useFont(openGymFont, 100);
  const wordmark = useMemo(
    () =>
      layoutWordmark(
        baseFont,
        width,
        height / 2 - height * WORDMARK_LIFT_RATIO,
        WORDMARK_WIDTH_RATIO,
      ),
    [baseFont, width, height],
  );
  // Where the wordmark lands in the band, relative to where it sits now.
  const bandMark = useMemo(() => {
    const target = layoutWordmark(
      baseFont,
      width,
      bandWordmarkCenterY(insets.top, bandHeight),
      BAND_WORDMARK_WIDTH_RATIO,
    );
    if (!wordmark || !target) return { dy: 0, scale: 1 };
    return {
      dy: target.centerY - wordmark.centerY,
      scale: target.size / wordmark.size,
    };
  }, [baseFont, width, bandHeight, insets.top, wordmark]);

  // Intro.
  useEffect(() => {
    if (reduced) {
      enter.value = ENTER_MS;
      mark.value = 1;
    } else {
      enter.value = withTiming(ENTER_MS, {
        duration: ENTER_MS,
        easing: Easing.linear,
      });
      mark.value = withDelay(
        MARK_DELAY_MS,
        withTiming(1, { duration: MARK_MS, easing: EASE_OUT }),
      );
    }
    const minTimer = setTimeout(
      () => setMinElapsed(true),
      reduced ? REDUCED_MIN_VISIBLE_MS : MIN_VISIBLE_MS,
    );
    return () => clearTimeout(minTimer);
  }, [reduced, enter, mark]);

  useEffect(() => {
    const slowTimer = setTimeout(() => setSlow(true), SLOW_BOOT_MS);
    return () => clearTimeout(slowTimer);
  }, []);

  // Exit.
  useEffect(() => {
    if (exiting.current || !ready || !(minElapsed || skipped)) return;
    exiting.current = true;
    const finish = () => onFinishRef.current();
    if (reduced) {
      fade.value = withTiming(
        1,
        {
          duration: REDUCED_FADE_MS,
          easing: Easing.linear,
          // The crossfade is the reduced-motion fallback itself.
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished) scheduleOnRN(finish);
        },
      );
      return;
    }
    if (exitTo === "band") {
      bandClip.value = withTiming(1, {
        duration: BAND_CLIP_MS,
        easing: EASE_IN_OUT,
      });
      bandFade.value = withDelay(
        BAND_DOT_FADE_DELAY_MS,
        withTiming(1, { duration: BAND_DOT_FADE_MS, easing: Easing.linear }),
      );
      bandMarkFade.value = withDelay(
        BAND_CLIP_MS,
        withTiming(
          1,
          { duration: BAND_MARK_FADE_MS, easing: Easing.linear },
          (finished) => {
            if (finished) scheduleOnRN(finish);
          },
        ),
      );
      return;
    }
    exit.value = withTiming(EXIT_MS, {
      duration: EXIT_MS,
      easing: Easing.linear,
    });
    markExit.value = withTiming(1, {
      duration: EXIT_MARK_MS,
      easing: EASE_IN,
    });
    fade.value = withDelay(
      EXIT_WAVE_MS,
      withTiming(
        1,
        { duration: EXIT_DOT_MS, easing: Easing.linear },
        (finished) => {
          if (finished) scheduleOnRN(finish);
        },
      ),
    );
  }, [
    ready,
    minElapsed,
    skipped,
    reduced,
    exitTo,
    exit,
    markExit,
    fade,
    bandClip,
    bandFade,
    bandMarkFade,
  ]);

  useEffect(
    () => () => {
      cancelAnimation(enter);
      cancelAnimation(mark);
      cancelAnimation(exit);
      cancelAnimation(markExit);
      cancelAnimation(fade);
      cancelAnimation(bandClip);
      cancelAnimation(bandFade);
      cancelAnimation(bandMarkFade);
    },
    [enter, mark, exit, markExit, fade, bandClip, bandFade, bandMarkFade],
  );

  // One path for every dot, rebuilt per frame while progress moves. Once the
  // pop-in has settled and no exit has started, the inputs stop changing and
  // so does the path.
  const dotsPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const elapsed = enter.value;
    const out = exit.value;
    for (let i = 0; i < dots.length; i += STRIDE) {
      const local = (elapsed - (dots[i + 3] ?? 0)) / DOT_POP_MS;
      if (local <= 0) continue;
      let scale = 1;
      if (local < 1) {
        const u = local - 1;
        scale = 1 + BACK_C3 * u * u * u + BACK_C1 * u * u;
      }
      if (out > 0) {
        const p = Math.min(
          Math.max((out - (dots[i + 4] ?? 0)) / EXIT_DOT_MS, 0),
          1,
        );
        scale *= 1 - p * p;
      }
      const radius = (dots[i + 2] ?? 0) * scale;
      if (radius > MIN_DRAW_RADIUS)
        path.addCircle(dots[i] ?? 0, dots[i + 1] ?? 0, radius);
    }
    return path;
  });

  const markOpacity = useDerivedValue(
    () => mark.value * (1 - markExit.value) * (1 - bandMarkFade.value),
  );
  const markTransform = useDerivedValue(() => [
    {
      translateY: -EXIT_RISE * markExit.value + bandMark.dy * bandClip.value,
    },
    {
      scale:
        (0.94 + 0.06 * mark.value) *
        (1 + (bandMark.scale - 1) * bandClip.value),
    },
  ]);
  const fillOpacity = useDerivedValue(() => 1 - bandFade.value);

  const rootStyle = useAnimatedStyle(() => ({
    opacity: 1 - fade.value,
    // The clip edge rises to the band; the blue itself fades with the dots.
    height: height - (height - bandHeight) * bandClip.value,
    backgroundColor: `rgba(0,85,255,${1 - bandFade.value})`,
  }));

  return (
    <Animated.View style={[styles.root, { height }, rootStyle]}>
      <StatusBar style="light" />
      <Pressable
        accessible={false}
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (ready) setSkipped(true);
        }}
      >
        <Canvas
          style={{ position: "absolute", top: 0, left: 0, width, height }}
          pointerEvents="none"
        >
          <Group opacity={fillOpacity}>
            <Fill color={BRAND_BLUE} />
            <Path path={dotsPath} color="white" />
          </Group>
          {wordmark ? (
            <Group
              opacity={markOpacity}
              transform={markTransform}
              origin={{ x: width / 2, y: wordmark.centerY }}
            >
              <SkiaWordmark layout={wordmark} />
            </Group>
          ) : null}
        </Canvas>
      </Pressable>

      {/* The loading hint matters only during a long boot. */}
      {slow && !ready ? (
        <View style={styles.footer} pointerEvents="none">
          <Text style={styles.footerText}>{t("Getting ready…")}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const splashStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      position: "absolute",
      top: 0,
      right: 0,
      left: 0,
      overflow: "hidden",
      backgroundColor: BRAND_BLUE,
      // zIndex alone is insufficient: Android orders layers using `elevation`.
      zIndex: 100,
      elevation: 32,
    },
    footer: {
      position: "absolute",
      bottom: theme.spacing.xxxl,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    footerText: {
      ...theme.type.supporting,
      color: "rgba(255, 255, 255, 0.75)",
    },
  });
