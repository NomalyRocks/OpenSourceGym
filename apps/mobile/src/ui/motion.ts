import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion } from "../theme";

/**
 * Üç eğri, üç süre. Hareket durum taşır (yükleniyor, geldi, seçildi);
 * dekorasyon için hareket yok.
 */
export const easing = {
  /** ease-out-quart — girişler ve açılışlar. */
  out: Easing.bezier(0.22, 1, 0.36, 1),
  /** Çıkışlar. */
  in: Easing.bezier(0.55, 0, 1, 0.45),
  /** Yer değiştiren şeyler (segment göstergesi, sekme çizgisi). */
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
 * Mount girişi: opaklık + küçük bir yukarı kayma.
 *
 * `prefers-reduced-motion` açıkken kayma düşer, yalnızca kısa bir crossfade
 * kalır — içerik hiçbir zaman animasyona bağlı olarak gizli kalmaz, başlangıç
 * değeri de görünürdür.
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
