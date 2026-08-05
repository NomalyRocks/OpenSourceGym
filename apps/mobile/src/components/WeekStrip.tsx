import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { WeekDay } from "../lib/dateKeys";
import { tabularNumbers, useThemedStyles, type Theme } from "../theme";
import { Plate, Skeleton } from "../ui";

export function WeekStrip({
  days,
  attendanceByDay,
  todayKey,
  loading,
  locale,
}: {
  days: WeekDay[];
  attendanceByDay: Map<string, number>;
  todayKey: string;
  loading: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(weekStripStyles);
  const weekdayFormatter = new Intl.DateTimeFormat(locale, {
    weekday: "short",
  });

  if (loading) {
    return (
      <Plate padded={false} style={styles.plate}>
        <View style={styles.row}>
          {days.map((day) => (
            <Skeleton key={day.key} height={40} radius={8} />
          ))}
        </View>
      </Plate>
    );
  }

  return (
    <Plate padded={false} style={styles.plate}>
      <View style={styles.row}>
        {days.map((day) => {
          const entries = attendanceByDay.get(day.key) ?? 0;
          const visited = entries > 0;
          const isToday = day.key === todayKey;
          const dateLabel = new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "long",
          }).format(day.date);
          const visitLabel = visited
            ? t("{{n}} visits", { n: entries })
            : t("No visit");

          return (
            <View
              key={day.key}
              accessible
              accessibilityLabel={`${dateLabel}, ${visitLabel}`}
              style={[
                styles.cell,
                visited && styles.cellVisited,
                isToday && !visited && styles.cellToday,
                isToday && visited && styles.cellVisitedToday,
              ]}
            >
              <Text style={styles.weekday} numberOfLines={1}>
                {weekdayFormatter.format(day.date)}
              </Text>
              <Text
                style={[styles.dayNumber, visited && styles.dayNumberVisited]}
              >
                {day.date.getDate()}
              </Text>
            </View>
          );
        })}
      </View>
    </Plate>
  );
}

const weekStripStyles = (theme: Theme) =>
  StyleSheet.create({
    plate: {
      padding: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      gap: theme.spacing.xxs,
    },
    cell: {
      flex: 1,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.small,
      borderWidth: 1,
      borderColor: "transparent",
      gap: 1,
    },
    cellVisited: {
      backgroundColor: theme.colors.successSurface,
      borderColor: theme.colors.success,
    },
    cellToday: { borderColor: theme.colors.accent },
    // A visited today remains green; the "today" marker falls back to border
    // thickness (the same solution as cellVisitedToday in Calendar.tsx).
    cellVisitedToday: { borderWidth: 2 },
    weekday: {
      ...theme.type.micro,
      color: theme.colors.textTertiary,
      textTransform: "capitalize",
    },
    dayNumber: {
      ...theme.type.label,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
    },
    dayNumberVisited: { color: theme.colors.success },
  });
