import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { MyBusyHours } from "@opengym/shared";
import { api } from "../lib/api";
import { tabularNumbers, useThemedStyles, type Theme } from "../theme";
import { Plate, Skeleton } from "../ui";

const CHART_HEIGHT = 56;

/** Typical hourly traffic of one gym today; cached per gym in state. */
export function BusyHoursCard({
  gymId,
  refreshToken,
}: {
  gymId: string | null;
  refreshToken: number;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(busyStyles);
  const [cache, setCache] = useState<Record<string, MyBusyHours | "failed">>(
    {},
  );
  const [seenToken, setSeenToken] = useState(refreshToken);

  // Pull-to-refresh drops the cache so the figures are fetched again.
  useEffect(() => {
    if (refreshToken !== seenToken) {
      setSeenToken(refreshToken);
      setCache({});
    }
  }, [refreshToken, seenToken]);

  const entry = gymId ? cache[gymId] : undefined;
  useEffect(() => {
    if (!gymId || entry !== undefined) return;
    let cancelled = false;
    api<MyBusyHours>(`/api/me/gyms/${encodeURIComponent(gymId)}/busy-hours`)
      .then((result) => {
        if (!cancelled) setCache((c) => ({ ...c, [gymId]: result }));
      })
      .catch(() => {
        if (!cancelled) setCache((c) => ({ ...c, [gymId]: "failed" }));
      });
    return () => {
      cancelled = true;
    };
  }, [gymId, entry]);

  if (!gymId || entry === "failed") return null;
  if (!entry) {
    return (
      <Plate>
        <Skeleton width="45%" height={18} />
        <Skeleton height={CHART_HEIGHT} style={styles.gap} />
      </Plate>
    );
  }
  if (entry.sampleDays === 0) return null;

  const nowHour = new Date().getHours();
  const traffic = entry.hours.filter((h) => h.avgEntries > 0);
  const shown =
    traffic.length > 0
      ? entry.hours.filter(
          (h) =>
            h.hour >= Math.min(...traffic.map((x) => x.hour)) &&
            h.hour <= Math.max(...traffic.map((x) => x.hour)),
        )
      : entry.hours.filter((h) => h.hour >= 6);
  const max = Math.max(...shown.map((h) => h.avgEntries), 0.0001);

  const upcoming = traffic.filter((h) => h.hour >= nowHour);
  const quietest = upcoming.length
    ? upcoming.reduce((a, b) => (b.avgEntries < a.avgEntries ? b : a))
    : null;

  return (
    <Plate>
      <Text style={styles.title}>{t("Busy hours today")}</Text>
      <View style={styles.chart} accessibilityLabel={t("Busy hours today")}>
        {shown.map((h) => (
          <View
            key={h.hour}
            style={[
              styles.bar,
              h.hour === nowHour && styles.barNow,
              { height: Math.max(3, (h.avgEntries / max) * CHART_HEIGHT) },
            ]}
          />
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{shown[0]?.hour}:00</Text>
        <Text style={styles.axisLabel}>
          {(shown[shown.length - 1]?.hour ?? 0) + 1}:00
        </Text>
      </View>
      {quietest ? (
        <Text style={styles.hint}>
          {t("Usually quietest around {{hour}}:00", { hour: quietest.hour })}
        </Text>
      ) : null}
    </Plate>
  );
}

const busyStyles = (theme: Theme) =>
  StyleSheet.create({
    gap: { marginTop: theme.spacing.sm },
    title: { ...theme.type.label, color: theme.colors.textTertiary },
    chart: {
      height: CHART_HEIGHT,
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 2,
      marginTop: theme.spacing.sm,
    },
    bar: {
      flex: 1,
      borderRadius: 2,
      backgroundColor: theme.colors.outlineStrong,
    },
    barNow: { backgroundColor: theme.colors.accent },
    axis: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 4,
    },
    axisLabel: {
      ...theme.type.micro,
      ...tabularNumbers,
      color: theme.colors.textTertiary,
    },
    hint: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },
  });
