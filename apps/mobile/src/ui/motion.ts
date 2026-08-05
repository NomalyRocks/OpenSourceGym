import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion } from "../theme";

/**
 * Three curves, three durations. Motion conveys state (loading, arrived,
 * selected); there is no motion purely for decoration.
 */
export const easing = {
  /** ease-out-quart—entrances and openings. */
  out: Easing.bezier(0.22, 1, 0.36, 1),
  /** Exits. */
  in: Easing.bezier(0.55, 0, 1, 0.45),
  /** Elements that change position (segment indicator, tab line). */
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
};

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => subscription.remove();
  }, []);

  return reduced;
}

/**
 * Mount entrance: opacity and a small upward shift.
 *
 * With `prefers-reduced-motion`, the shift is removed and only a short crossfade
 * remains—content is never left hidden because of animation, and its initial
 * value is visible.
 */
export function useEnter({
  delay = 0,
  distance = 10,
  duration = motion.standard,
}: { delay?: number; distance?: number; duration?: number } = {}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: reduced ? Math.min(duration, 150) : duration,
      delay: reduced ? 0 : delay,
      easing: easing.out,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, duration, progress, reduced]);

  return {
    opacity: progress,
    transform: reduced
      ? []
      : [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [distance, 0],
            }),
          },
        ],
  };
}
