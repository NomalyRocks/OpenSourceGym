import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { fetchAttendance } from "../lib/attendance";
import { weekStart, weekStreak, weeklyVisits } from "../lib/activity";
import { dayKey } from "../lib/dateKeys";
import { tabularNumbers, useThemedStyles, type Theme } from "../theme";
import { Plate, Skeleton } from "../ui";

const WEEKS = 12;
const BAR_WEEKS = 4;
const BAR_MAX_HEIGHT = 44;

/** This week's visits, the weekly streak and a 4-week bar chart. */
export function ActivityCard({
  todayKey,
  refreshToken,
}: {
  todayKey: string;
  refreshToken: number;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(activityStyles);
  const [counts, setCounts] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const [y, m, d] = todayKey.split("-").map(Number);
    const today = new Date(y!, m! - 1, d!);
    const first = weekStart(today);
    first.setDate(first.getDate() - 7 * (WEEKS - 1));
    let cancelled = false;
    fetchAttendance({ from: dayKey(first), to: todayKey })
      .then((result) => {
        if (cancelled) return;
        setCounts(
          weeklyVisits(
            result.days.map((day) => ({
              date: day.date,
              entries: day.entries,
            })),
            today,
            WEEKS,
          ),
        );
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [todayKey, refreshToken]);

  const bars = useMemo(() => counts?.slice(-BAR_WEEKS) ?? [], [counts]);

  // Secondary card: hide quietly when the history cannot load.
  if (failed && !counts) return null;

  if (!counts) {
    return (
      <Plate>
        <Skeleton width="40%" height={18} />
        <Skeleton height={44} style={styles.gap} />
      </Plate>
    );
  }

  const thisWeek = counts[counts.length - 1] ?? 0;
  const streak = weekStreak(counts);
  const max = Math.max(1, ...bars);

  return (
    <Plate>
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.label}>{t("This week")}</Text>
          <Text style={styles.value}>{t("{{n}} visits", { n: thisWeek })}</Text>
          <Text style={styles.streak}>
            {streak > 0
              ? t("{{n}}-week streak", { n: streak })
              : t("No streak yet — visit this week to start one.")}
          </Text>
        </View>
        <View
          style={styles.chart}
          accessibilityLabel={t("Visits in the last 4 weeks")}
        >
          {bars.map((count, index) => {
            const current = index === bars.length - 1;
            return (
              <View
                key={index}
                style={[
                  styles.bar,
                  current && styles.barCurrent,
                  {
                    height: Math.max(4, (count / max) * BAR_MAX_HEIGHT),
                  },
                ]}
              />
            );
          })}
        </View>
      </View>
    </Plate>
  );
}

const activityStyles = (theme: Theme) =>
  StyleSheet.create({
    gap: { marginTop: theme.spacing.sm },
    row: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    copy: { flex: 1, minWidth: 0 },
    label: { ...theme.type.label, color: theme.colors.textTertiary },
    value: {
      ...theme.type.title,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
      marginTop: 2,
    },
    streak: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    chart: {
      height: BAR_MAX_HEIGHT,
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
    },
    bar: {
      width: 14,
      borderRadius: 4,
      backgroundColor: theme.colors.outlineStrong,
    },
    barCurrent: { backgroundColor: theme.colors.accent },
  });
