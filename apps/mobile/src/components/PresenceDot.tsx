import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, StyleSheet, Text, View } from "react-native";
import { formatInsideDuration, msToNextMinute } from "../lib/presence";
import { tabularNumbers, useThemedStyles, type Theme } from "../theme";
import { useReducedMotion } from "../ui";

/** Pulsing green dot plus time spent inside; rendered only while inside. */
export function PresenceDot({
  enteredAt,
  gymName,
}: {
  enteredAt: string;
  gymName: string;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(dotStyles);
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (reduced) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  // Tick exactly on minute boundaries of the elapsed time, then every minute.
  useEffect(() => {
    const start = new Date(enteredAt).getTime();
    if (Number.isNaN(start)) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    setNow(Date.now());
    const timeout = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), 60_000);
      },
      msToNextMinute(start, Date.now()),
    );
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [enteredAt]);

  const label = (minutes: number) => t("{{n}} min", { n: minutes });
  const elapsed = now - new Date(enteredAt).getTime();
  const text = formatInsideDuration(elapsed, label);

  return (
    <View
      accessible
      accessibilityLabel={t("Inside {{gym}} for {{duration}}", {
        gym: gymName,
        duration: formatInsideDuration(elapsed, label),
      })}
      style={styles.row}
    >
      <Animated.View style={[styles.dot, { opacity: pulse }]} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const dotStyles = (theme: Theme) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 6 },
    dot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: theme.colors.success,
    },
    text: {
      ...theme.type.label,
      ...tabularNumbers,
      color: theme.colors.textSecondary,
    },
  });
