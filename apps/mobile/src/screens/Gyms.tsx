import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type {
  MyOccupancyResponse,
  MySubscription,
  OccupancyResponse,
} from "@opengym/shared";
import { api } from "../lib/api";
import { GymCard } from "../components/GymCard";
import { GymGlyph } from "../components/icons";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import {
  Badge,
  EmptyState,
  Plate,
  ScreenHeader,
  ScrollScreen,
  Skeleton,
  StatusMessage,
} from "../ui";

const OCCUPANCY_POLL_MS = 60_000;

export function Gyms({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(gymsStyles);
  const locale = dateLocale(i18n.resolvedLanguage);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOccupancy = useCallback(async () => {
    try {
      const result = await api<MyOccupancyResponse>("/api/me/occupancy");
      setOccupancy(result.gyms);
    } catch {
      // Occupancy is live decoration; keep the last known values on failure.
    }
  }, []);

  const load = useCallback(async () => {
    const [subscriptionResult, occupancyResult] = await Promise.allSettled([
      api<MySubscription>("/api/me/subscription"),
      api<MyOccupancyResponse>("/api/me/occupancy"),
    ]);
    if (subscriptionResult.status === "fulfilled") {
      setSubscription(subscriptionResult.value);
      setError(null);
    } else {
      setError(
        errorMessage(
          subscriptionResult.reason,
          t,
          "Membership data could not be loaded.",
        ),
      );
    }
    if (occupancyResult.status === "fulfilled") {
      setOccupancy(occupancyResult.value.gyms);
    }
    setLoaded(true);
  }, [t]);

  // Refresh whenever the tab becomes active; poll occupancy while it stays so.
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void loadOccupancy(), OCCUPANCY_POLL_MS);
    return () => clearInterval(timer);
  }, [active, load, loadOccupancy]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const formatDate = (value?: string | null) =>
    value
      ? new Date(value).toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  const frozen = subscription?.freeze != null;
  const isActive = subscription?.active === true;
  const gyms = subscription?.gyms ?? [];
  const remainingDays = subscription?.remainingDays ?? 0;

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <ScreenHeader title={t("Gyms")} />

      {!loaded ? (
        <Plate>
          <Skeleton width="42%" height={16} />
          <Skeleton width="66%" height={26} style={styles.skeletonGap} />
        </Plate>
      ) : error ? (
        <Plate>
          <StatusMessage
            text={error}
            actionLabel={t("Try again")}
            onAction={() => void load()}
          />
        </Plate>
      ) : !isActive && !frozen ? (
        <EmptyState
          icon={<GymGlyph size={32} color={theme.colors.textTertiary} />}
          title={t("No active membership")}
          body={t(
            "Your membership is set up at the front desk. Once it is active, your gyms and their live occupancy appear here.",
          )}
        />
      ) : (
        <>
          <Plate>
            <View style={styles.summaryTop}>
              <Text style={styles.summaryKind}>{t("Membership")}</Text>
              <Badge
                label={frozen ? t("Frozen") : t("Active")}
                tone={frozen ? "neutral" : "success"}
              />
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryDays}>{remainingDays}</Text>
              <Text style={styles.summaryUnit}>{t("Days left")}</Text>
              <Text style={styles.summaryEnds} numberOfLines={1}>
                {t("Ends {{date}}", { date: formatDate(subscription?.endsAt) })}
              </Text>
            </View>
            {frozen && subscription?.freeze ? (
              <StatusMessage
                tone="neutral"
                style={styles.note}
                text={t(
                  "Your membership is frozen since {{date}}. Scanning in at the turnstile resumes it.",
                  { date: formatDate(subscription.freeze.startedAt) },
                )}
              />
            ) : null}
          </Plate>

          <View style={styles.cards}>
            {gyms.map((gym) => (
              <GymCard
                key={gym.id}
                gym={gym}
                occupancy={occupancy.find((o) => o.gymId === gym.id)}
                formatDate={formatDate}
              />
            ))}
          </View>
        </>
      )}
    </ScrollScreen>
  );
}

const gymsStyles = (theme: Theme) =>
  StyleSheet.create({
    skeletonGap: { marginTop: theme.spacing.sm },
    summaryTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      minHeight: 26,
    },
    summaryKind: { ...theme.type.label, color: theme.colors.textTertiary },
    summaryRow: {
      flexDirection: "row",
      alignItems: "baseline",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.sm,
    },
    summaryDays: {
      ...theme.type.metric,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
    },
    summaryUnit: { ...theme.type.body, color: theme.colors.textSecondary },
    summaryEnds: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textTertiary,
      marginLeft: "auto",
    },
    note: { marginTop: theme.spacing.md },
    cards: { gap: theme.spacing.md, marginTop: theme.spacing.lg },
  });
