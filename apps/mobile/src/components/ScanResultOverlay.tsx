import { Canvas, Circle, Group, Path, Skia } from "@shopify/react-native-skia";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
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
  type SharedValue,
  type WithTimingConfig,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { halftoneGrid } from "../lib/halftoneField";
import { useThemedStyles, type Theme } from "../theme";
import { useReducedMotion } from "../ui";
import { CELL, MIN_DRAW_RADIUS } from "../ui/halftone";

/** White text on these fills: 4.97:1 and 5.69:1 (WCAG AA needs 4.5:1). */
export const SCAN_SUCCESS_COLOR = "#12813A";
export const SCAN_ERROR_COLOR = "#C4282D";

const GROW_MS = 420;
const RIPPLE_DELAY_MS = 250;
const RIPPLE_MS = 500;
const ICON_DELAY_MS = 380;
const ICON_MS = 280;
const TITLE_DELAY_MS = 560;
const TEXT_MS = 350;
const TEXT_STAGGER_MS = 110;
const RISE = 12;
const REDUCED_FADE_MS = 150;

const ICON_RADIUS = 44;
const ICON_STROKE = 5;

/* Same cubic-bezier as `easing.out` in `ui/motion.ts`, built for the UI thread. */
const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);

/** A ring of dots this wide (dp) is visible around the expanding radius. */
const RIPPLE_BAND = 90;
/** Dot stride in the flat array handed to the worklet: x, y, dot radius, distance. */
const STRIDE = 4;

const CHECK_PATH = (() => {
  const path = Skia.Path.Make();
  path.moveTo(-17, 2);
  path.lineTo(-6, 13);
  path.lineTo(18, -12);
  return path;
})();

const CROSS_A = (() => {
  const path = Skia.Path.Make();
  path.moveTo(-14, -14);
  path.lineTo(14, 14);
  return path;
})();

const CROSS_B = (() => {
  const path = Skia.Path.Make();
  path.moveTo(14, -14);
  path.lineTo(-14, 14);
  return path;
})();

export interface ScanResultAction {
  title: string;
  onPress: () => void;
}

/**
 * Full-screen result moment after a turnstile scan: a colored circle grows from
 * the viewfinder until it covers the screen, a halftone ripple crosses it, the
 * icon draws itself and the copy rises in.
 *
 * It is a `Modal` so it also covers the tab bar, which is mounted outside the
 * scan page. Mount it only while a result is showing.
 */
export function ScanResultOverlay({
  kind,
  title,
  subtitle,
  detail,
  note,
  hint,
  primary,
  link,
  origin,
  onRequestClose,
}: {
  kind: "success" | "error";
  title: string;
  subtitle: string;
  detail?: string;
  note?: string;
  hint?: string;
  primary: ScanResultAction;
  link?: ScanResultAction;
  /** Window coordinates the circle grows from; defaults to the screen center. */
  origin?: { x: number; y: number } | null;
  onRequestClose: () => void;
}) {
  const styles = useThemedStyles(overlayStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  // Measured from the overlay root: on Android `useWindowDimensions` leaves out
  // the navigation bar, which would stop the fill short of the screen bottom.
  const [size, setSize] = useState(() => Dimensions.get("screen"));
  const { width, height } = size;
  const rootRef = useRef<View>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const success = kind === "success";
  const color = success ? SCAN_SUCCESS_COLOR : SCAN_ERROR_COLOR;

  // The origin is in window coordinates; subtract where this root sits in the
  // window so a status-bar offset between the two cannot shift the circle.
  const cx = origin ? origin.x - offset.x : width / 2;
  const cy = origin ? origin.y - offset.y : height / 2;
  const maxRadius =
    Math.max(
      Math.hypot(cx, cy),
      Math.hypot(width - cx, cy),
      Math.hypot(cx, height - cy),
      Math.hypot(width - cx, height - cy),
    ) + 2;
  const iconY = height * 0.32;

  const grow = useSharedValue(0);
  const ripple = useSharedValue(0);
  const draw = useSharedValue(0);
  const fade = useSharedValue(0);
  const titleIn = useSharedValue(0);
  const subtitleIn = useSharedValue(0);
  const detailIn = useSharedValue(0);
  const actionsIn = useSharedValue(0);

  useEffect(() => {
    void AccessibilityInfo.announceForAccessibility(title);
  }, [title]);

  useEffect(() => {
    // Explicit `Never`: a system reduce-motion setting would otherwise make
    // Reanimated jump timings straight to their end value, skipping the choreography
    // this effect already decides on for itself.
    const config = (
      duration: number,
      easing: WithTimingConfig["easing"] = Easing.linear,
    ) => ({
      duration,
      easing,
      reduceMotion: ReduceMotion.Never,
    });
    if (reduced) {
      grow.value = 1;
      ripple.value = 1;
      draw.value = 1;
      titleIn.value = 1;
      subtitleIn.value = 1;
      detailIn.value = 1;
      actionsIn.value = 1;
      fade.value = 0;
      fade.value = withTiming(1, config(REDUCED_FADE_MS));
      return;
    }
    fade.value = 1;
    grow.value = withTiming(1, config(GROW_MS, EASE_OUT));
    ripple.value = withDelay(RIPPLE_DELAY_MS, withTiming(1, config(RIPPLE_MS)));
    draw.value = withDelay(
      ICON_DELAY_MS,
      withTiming(1, config(ICON_MS, EASE_OUT)),
    );
    const text = (index: number) =>
      withDelay(
        TITLE_DELAY_MS + index * TEXT_STAGGER_MS,
        withTiming(1, config(TEXT_MS, EASE_OUT)),
      );
    titleIn.value = text(0);
    subtitleIn.value = text(1);
    detailIn.value = text(2);
    actionsIn.value = text(3);

    return () => {
      for (const value of [
        grow,
        ripple,
        draw,
        fade,
        titleIn,
        subtitleIn,
        detailIn,
        actionsIn,
      ]) {
        cancelAnimation(value);
        value.value = 0;
      }
    };
  }, [
    reduced,
    success,
    grow,
    ripple,
    draw,
    fade,
    titleIn,
    subtitleIn,
    detailIn,
    actionsIn,
  ]);

  // Flat [x, y, radius, distance-from-origin] per dot of an even grid.
  const dots = useMemo(() => {
    const { cols, rows } = halftoneGrid(width, height, CELL);
    const flat: number[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * CELL;
        const y = (row + 0.5) * CELL;
        flat.push(x, y, CELL * 0.3, Math.hypot(x - cx, y - cy));
      }
    }
    return flat;
  }, [width, height, cx, cy]);

  const ripplePath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const progress = ripple.value;
    if (progress <= 0 || progress >= 1) return path;
    const front = progress * (maxRadius + RIPPLE_BAND);
    for (let i = 0; i < dots.length; i += STRIDE) {
      const distance = dots[i + 3] ?? 0;
      const proximity = 1 - Math.abs(distance - front) / RIPPLE_BAND;
      if (proximity <= 0) continue;
      const radius = (dots[i + 2] ?? 0) * proximity;
      if (radius > MIN_DRAW_RADIUS)
        path.addCircle(dots[i] ?? 0, dots[i + 1] ?? 0, radius);
    }
    return path;
  });
  const rippleOpacity = useDerivedValue(() => 0.25 * (1 - ripple.value));

  const circleRadius = useDerivedValue(() => maxRadius * grow.value);
  const canvasOpacity = fade;
  const iconOpacity = useDerivedValue(() => Math.min(draw.value * 2, 1));
  const crossA = useDerivedValue(() => Math.min(draw.value * 2, 1));
  const crossB = useDerivedValue(() => Math.max(draw.value * 2 - 1, 0));

  const actionsStyle = useAnimatedStyle(() => ({ opacity: actionsIn.value }));

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onRequestClose}
    >
      <StatusBar style="light" />
      <View
        ref={rootRef}
        style={styles.root}
        onLayout={(event) => {
          rootRef.current?.measureInWindow((x, y) =>
            setOffset((prev) =>
              prev.x === x && prev.y === y ? prev : { x, y },
            ),
          );
          const { width: w, height: h } = event.nativeEvent.layout;
          setSize((prev) =>
            w > 0 && h > 0 && (prev.width !== w || prev.height !== h)
              ? { ...prev, width: w, height: h }
              : prev,
          );
        }}
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, { opacity: canvasOpacity }]}
        >
          <Canvas style={{ width, height }} pointerEvents="none">
            <Circle cx={cx} cy={cy} r={circleRadius} color={color} />
            <Path path={ripplePath} color="white" opacity={rippleOpacity} />
            <Group opacity={iconOpacity}>
              <Circle
                cx={width / 2}
                cy={iconY}
                r={ICON_RADIUS}
                style="stroke"
                strokeWidth={3}
                color="white"
              />
            </Group>
            <Group>
              <Group
                transform={[{ translateX: width / 2 }, { translateY: iconY }]}
              >
                {success ? (
                  <Path
                    path={CHECK_PATH}
                    style="stroke"
                    strokeWidth={ICON_STROKE}
                    strokeCap="round"
                    strokeJoin="round"
                    color="white"
                    start={0}
                    end={draw}
                  />
                ) : (
                  <>
                    <CrossStroke path={CROSS_A} end={crossA} />
                    <CrossStroke path={CROSS_B} end={crossB} />
                  </>
                )}
              </Group>
            </Group>
          </Canvas>
        </Animated.View>

        <View
          style={[styles.copy, { top: iconY + ICON_RADIUS + 28 }]}
          pointerEvents="box-none"
        >
          <Rise value={titleIn}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          </Rise>
          <Rise value={subtitleIn}>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </Rise>
          <Rise value={detailIn}>
            {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            {note ? <Text style={styles.note}>{note}</Text> : null}
            {hint ? <Text style={styles.detail}>{hint}</Text> : null}
          </Rise>
        </View>

        <Animated.View
          style={[
            styles.actions,
            { paddingBottom: insets.bottom + 24 },
            actionsStyle,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={primary.title}
            onPress={primary.onPress}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            <Text style={[styles.primaryText, { color }]}>{primary.title}</Text>
          </Pressable>
          {link ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={link.title}
              onPress={link.onPress}
              hitSlop={8}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            >
              <Text style={styles.linkText}>{link.title}</Text>
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

function CrossStroke({
  path,
  end,
}: {
  path: ReturnType<typeof Skia.Path.Make>;
  end: SharedValue<number>;
}) {
  return (
    <Path
      path={path}
      style="stroke"
      strokeWidth={ICON_STROKE}
      strokeCap="round"
      color="white"
      start={0}
      end={end}
    />
  );
}

/** Fade + rise-in wrapper driven by a 0 → 1 shared value. */
function Rise({
  value,
  children,
}: {
  value: SharedValue<number>;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: value.value,
    transform: [{ translateY: (1 - value.value) * RISE }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

const overlayStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1 },
    copy: {
      position: "absolute",
      left: 0,
      right: 0,
      paddingHorizontal: theme.spacing.lg,
      alignItems: "center",
    },
    title: {
      ...theme.type.sectionTitle,
      color: "#FFFFFF",
      textAlign: "center",
    },
    subtitle: {
      ...theme.type.body,
      color: "#FFFFFF",
      textAlign: "center",
      marginTop: theme.spacing.xs,
    },
    detail: {
      ...theme.type.supporting,
      color: "#FFFFFF",
      textAlign: "center",
      marginTop: theme.spacing.md,
    },
    note: {
      ...theme.type.supporting,
      color: "#FFFFFF",
      textAlign: "center",
      marginTop: theme.spacing.sm,
    },
    actions: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: theme.spacing.lg,
      alignItems: "stretch",
    },
    primary: {
      minHeight: 52,
      borderRadius: theme.radius.control,
      backgroundColor: "#FFFFFF",
      alignItems: "center",
      justifyContent: "center",
    },
    primaryText: { ...theme.type.label },
    link: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      marginTop: theme.spacing.xs,
    },
    linkText: {
      ...theme.type.label,
      color: "#FFFFFF",
      textDecorationLine: "underline",
    },
    pressed: { opacity: 0.8 },
  });
