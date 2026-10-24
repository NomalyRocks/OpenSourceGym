import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { MySubscriptionGym, OccupancyResponse } from "@opengym/shared";
import { occupancyLevel, type OccupancyTone } from "../lib/occupancy";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import { Badge, Meter, Plate } from "../ui";
import { HalftoneBand } from "./HalftoneBand";

const BAND_HEIGHT = 84;

/** Stable positive integer from a gym id, so each gym keeps its own landscape. */
export function gymSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Theme colour of an occupancy tone. */
export function occupancyColor(theme: Theme, tone: OccupancyTone): string {
  switch (tone) {
    case "error":
      return theme.colors.error;
    case "warning":
      return theme.colors.warning;
    case "success":
      return theme.colors.success;
    default:
      return theme.colors.textTertiary;
  }
}

/** One gym of the membership: halftone header, days left, live occupancy. */
export function GymCard({
  gym,
  occupancy,
  formatDate,
}: {
  gym: MySubscriptionGym;
  occupancy?: OccupancyResponse;
  formatDate: (value?: string | null) => string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(gymCardStyles);
  const [width, setWidth] = useState(0);

  const level = occupancyLevel(occupancy?.ratio);
  const capacity = occupancy?.capacity ?? null;
  const label = t(level.label);

  return (
    <Plate padded={false} style={styles.card}>
      <View
        style={styles.header}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <HalftoneBand
            height={BAND_HEIGHT}
            width={width}
            seed={gymSeed(gym.id)}
            showWordmark={false}
          />
        ) : null}
        <View style={styles.headerContent}>
          <Text style={styles.name} numberOfLines={2}>
            {gym.name}
          </Text>
          {gym.active ? null : <Badge label={t("Inactive")} tone="neutral" />}
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.daysRow}>
          <Text style={styles.days}>{gym.remainingDays ?? 0}</Text>
          <Text style={styles.daysUnit}>{t("Days left")}</Text>
          <Text style={styles.ends} numberOfLines={1}>
            {t("Ends {{date}}", { date: formatDate(gym.endsAt) })}
          </Text>
        </View>

        {occupancy && capacity != null ? (
          <View style={styles.occupancy}>
            <View style={styles.occupancyHeader}>
              <Text style={styles.people}>
                {t("{{inside}} of {{capacity}} people inside", {
                  inside: occupancy.inside,
                  capacity,
                })}
              </Text>
              <Badge label={label} tone={level.tone} />
            </View>
            <Meter
              ratio={level.percent == null ? null : level.percent / 100}
              color={occupancyColor(theme, level.tone)}
              label={gym.name}
              valueText={label}
            />
          </View>
        ) : null}
      </View>
    </Plate>
  );
}

const gymCardStyles = (theme: Theme) =>
  StyleSheet.create({
    card: { overflow: "hidden" },
    header: { height: BAND_HEIGHT, backgroundColor: "#0055FF" },
    headerContent: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
    },
    name: {
      ...theme.type.sectionTitle,
      flex: 1,
      color: "#FFFFFF",
      textShadowColor: "rgba(0, 40, 140, 0.85)",
      textShadowRadius: 8,
      textShadowOffset: { width: 0, height: 0 },
    },
    body: { padding: theme.spacing.lg, gap: theme.spacing.md },
    daysRow: {
      flexDirection: "row",
      alignItems: "baseline",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
    },
    days: {
      ...theme.type.metric,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
    },
    daysUnit: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
    },
    ends: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textTertiary,
      marginLeft: "auto",
    },
    occupancy: { gap: theme.spacing.xs },
    occupancyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    people: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      flex: 1,
    },
  });
