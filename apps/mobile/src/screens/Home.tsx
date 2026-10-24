import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type {
  MyProfile,
  MyOccupancyResponse,
  MyPresence,
  MySubscription,
  OccupancyResponse,
} from "@opengym/shared";
import { api } from "../lib/api";
import { fetchAttendance, type AttendanceDay } from "../lib/attendance";
import { buildWeek, dayKey } from "../lib/dateKeys";
import { Avatar } from "../components/Avatar";
import { ActivityCard } from "../components/ActivityCard";
import { BusyHoursCard } from "../components/BusyHoursCard";
import { PresenceDot } from "../components/PresenceDot";
import { occupancyLevel } from "../lib/occupancy";
import { MembershipPager } from "../components/MembershipPager";
import { BellGlyph, QrGlyph } from "../components/icons";
import { WeekStrip } from "../components/WeekStrip";
import { useThemedStyles, type Theme } from "../theme";
import {
  Badge,
  Button,
  IconButton,
  Plate,
  ScrollScreen,
  Skeleton,
  StatusMessage,
} from "../ui";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

const HEADER_AVATAR = 46;

function useCurrentDayKey() {
  const [currentDayKey, setCurrentDayKey] = useState(() => dayKey(new Date()));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;

      const nextDayKey = dayKey(new Date());
      setCurrentDayKey((previousDayKey) =>
        previousDayKey === nextDayKey ? previousDayKey : nextDayKey,
      );
    });

    return () => subscription.remove();
  }, []);

  return currentDayKey;
}

export function Home({
  userName,
  onOpenQr,
  onOpenNotifications,
  onOpenProfile,
  onRefreshed,
  unreadCount = 0,
  isCurrentTab = true,
}: {
  userName: string;
  onOpenQr: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  /** Called after a pull-to-refresh so the shell can re-check the ban */
  onRefreshed?: () => void;
  unreadCount?: number;
  /** Whether Home is the settled tab; presence refreshes each time it becomes so */
  isCurrentTab?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(homeStyles);
  const locale = dateLocale(i18n.resolvedLanguage);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse[]>([]);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );
  const [attendance, setAttendance] = useState<AttendanceDay[]>([]);
  const [attendanceLoaded, setAttendanceLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [presence, setPresence] = useState<MyPresence | null>(null);

  const todayKey = useCurrentDayKey();
  const week = useMemo(() => {
    const [year, month, date] = todayKey.split("-").map(Number);
    return buildWeek(new Date(year!, month! - 1, date!));
  }, [todayKey]);

  const weekFrom = week[0]?.key;
  const weekTo = week[6]?.key;

  const load = useCallback(async () => {
    const [
      profileResult,
      subscriptionResult,
      occupancyResult,
      attendanceResult,
    ] = await Promise.allSettled([
      api<MyProfile>("/api/me/profile"),
      api<MySubscription>("/api/me/subscription"),
      api<MyOccupancyResponse>("/api/me/occupancy"),
      weekFrom && weekTo
        ? fetchAttendance({ from: weekFrom, to: weekTo })
        : Promise.resolve({ days: [], timeZone: "" }),
    ]);

    // The profile only supplies the header image; if unavailable, Avatar falls
    // back to initials, so no separate error message is shown.
    if (profileResult.status === "fulfilled") setProfile(profileResult.value);
    setProfileLoaded(true);

    if (subscriptionResult.status === "fulfilled") {
      setSubscription(subscriptionResult.value);
      setSubscriptionError(null);
    } else {
      setSubscriptionError(
        errorMessage(
          subscriptionResult.reason,
          t,
          "Membership data could not be loaded.",
        ),
      );
    }
    setSubscriptionLoaded(true);

    // Occupancy only feeds the pager chips; without it they are left out.
    if (occupancyResult.status === "fulfilled") {
      setOccupancy(occupancyResult.value.gyms);
    }

    // The attendance strip is secondary: if it cannot load, it remains neutral
    // without cluttering the rest of Home with an error banner.
    if (attendanceResult.status === "fulfilled") {
      setAttendance(attendanceResult.value.days);
    }
    setAttendanceLoaded(true);
  }, [t, weekFrom, weekTo]);

  useEffect(() => {
    void load();
  }, [load]);

  // The presence indicator is decoration: failures simply hide it.
  const loadPresence = useCallback(async () => {
    try {
      setPresence(await api<MyPresence>("/api/me/presence"));
    } catch {
      // Keep the last known state.
    }
  }, []);

  // Home stays mounted in the tab pager, so a scan on the scan tab would
  // otherwise leave the indicator stale until the app is backgrounded.
  useEffect(() => {
    if (!isCurrentTab) return;
    void loadPresence();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadPresence();
    });
    return () => subscription.remove();
  }, [isCurrentTab, loadPresence]);

  async function refresh() {
    setRefreshing(true);
    setRefreshToken((n) => n + 1);
    await Promise.all([load(), loadPresence()]);
    onRefreshed?.();
    setRefreshing(false);
  }

  // An older API may omit these fields during rollout.
  const freeze = subscription?.freeze ?? null;

  const firstName = userName.trim().split(/\s+/)[0] || t("Member");
  const formatDate = (value?: string | null) =>
    value
      ? new Date(value).toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  const attendanceByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of attendance) map.set(day.date, day.entries);
    return map;
  }, [attendance]);

  const active = subscription?.active === true;
  const gyms = subscription?.gyms ?? [];
  // Warn on the soonest per-gym end; fall back to the chain-level figure when
  // an older API sends no per-gym days.
  const remainingDays = gyms.length
    ? Math.min(...gyms.map((gym) => gym.remainingDays ?? Infinity))
    : (subscription?.remainingDays ?? 0);
  // A frozen membership is paused, not running out: stay calm and neutral.
  const frozen = freeze != null;
  const expiringSoon = active && !frozen && remainingDays <= 7;
  const currentGym = gyms[Math.min(pageIndex, Math.max(0, gyms.length - 1))];

  // Quietest gym right now, only when it is actually quiet and there is a
  // choice or a figure worth stating; gyms without capacity data are skipped.
  let goodTime: { gymName: string; percent: number } | null = null;
  if (active && !frozen) {
    for (const gym of occupancy) {
      const level = occupancyLevel(gym.ratio);
      if (level.percent == null || level.label !== "Quiet") continue;
      if (!goodTime || level.percent < goodTime.percent) {
        goodTime = { gymName: gym.gymName, percent: level.percent };
      }
    }
  }

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <View style={styles.header}>
        {profileLoaded ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Profile")}
            onPress={onOpenProfile}
            style={({ pressed }) => [
              styles.avatarButton,
              pressed && styles.pressed,
            ]}
          >
            <Avatar
              size={HEADER_AVATAR}
              name={profile?.name ?? userName}
              photoUrl={profile?.profilePhotoUrl ?? null}
              locale={locale}
            />
          </Pressable>
        ) : (
          <Skeleton
            width={HEADER_AVATAR}
            height={HEADER_AVATAR}
            radius={HEADER_AVATAR / 2}
          />
        )}

        <View style={styles.headerCopy}>
          <Text style={styles.greeting} numberOfLines={1}>
            {t("Hello, {{name}}", { name: firstName })}
          </Text>
          <View style={styles.titleRow}>
            <Text
              accessibilityRole="header"
              style={[styles.title, styles.titleText]}
              numberOfLines={1}
            >
              {t("At the gym today")}
            </Text>
            {presence?.inside ? (
              <PresenceDot
                enteredAt={presence.inside.enteredAt}
                gymName={presence.inside.gymName}
              />
            ) : null}
          </View>
        </View>
        <IconButton
          label={t("Notifications")}
          onPress={onOpenNotifications}
          badgeCount={unreadCount}
          icon={(color) => <BellGlyph size={21} color={color} />}
        />
      </View>

      <View style={styles.weekStrip}>
        <WeekStrip
          days={week}
          attendanceByDay={attendanceByDay}
          todayKey={todayKey}
          loading={!attendanceLoaded}
          locale={locale}
        />
      </View>

      <View style={styles.weekStrip}>
        <ActivityCard todayKey={todayKey} refreshToken={refreshToken} />
      </View>

      {/* Membership: one pager page per gym; inactive keeps a single card. */}
      {!subscriptionLoaded ? (
        <Plate>
          <Skeleton width="42%" height={16} />
          <Skeleton width="66%" height={26} style={styles.skeletonGap} />
          <Skeleton height={44} style={styles.skeletonGap} />
        </Plate>
      ) : subscriptionError ? (
        <Plate>
          <StatusMessage
            text={subscriptionError}
            actionLabel={t("Try again")}
            onAction={() => void load()}
          />
        </Plate>
      ) : active && gyms.length > 0 ? (
        <MembershipPager
          gyms={gyms}
          occupancy={occupancy}
          formatDate={formatDate}
          onPageChange={setPageIndex}
          badge={{
            label: frozen ? t("Frozen") : t("Active"),
            tone: frozen ? "neutral" : expiringSoon ? "warning" : "success",
          }}
        />
      ) : (
        <Plate>
          <View style={styles.passTopRow}>
            <Text style={styles.passKind}>{t("Membership")}</Text>
            <Badge label={t("Inactive")} tone="error" />
          </View>
          <Text style={styles.passInactive}>
            {t(
              "You do not have an active membership. Contact gym reception for help.",
            )}
          </Text>
        </Plate>
      )}

      {goodTime ? (
        <Text style={styles.goodTime}>
          {t("{{gym}} is quiet right now ({{percent}}%)", {
            gym: goodTime.gymName,
            percent: goodTime.percent,
          })}
        </Text>
      ) : null}

      {active && currentGym ? (
        <View style={styles.busyHours}>
          <BusyHoursCard gymId={currentGym.id} refreshToken={refreshToken} />
        </View>
      ) : null}

      {freeze ? (
        <StatusMessage
          tone="neutral"
          style={styles.expiryNote}
          text={t(
            "Your membership is frozen since {{date}}. Scanning in at the turnstile resumes it.",
            { date: formatDate(freeze.startedAt) },
          )}
        />
      ) : null}

      {expiringSoon ? (
        <StatusMessage
          tone="warning"
          style={styles.expiryNote}
          text={t(
            "Your membership expires soon — visit reception to renew it.",
          )}
        />
      ) : null}

      <View style={styles.primaryAction}>
        <Button
          title={t("Scan turnstile QR code")}
          onPress={onOpenQr}
          icon={(color) => <QrGlyph size={20} color={color} />}
        />
      </View>
    </ScrollScreen>
  );
}

const homeStyles = (theme: Theme) =>
  StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    // Tapping the image opens the Profile tab—the header's only shortcut.
    avatarButton: { borderRadius: HEADER_AVATAR / 2 },
    pressed: { opacity: 0.7 },
    headerCopy: { flex: 1, minWidth: 0 },
    greeting: { ...theme.type.supporting, color: theme.colors.textSecondary },
    title: {
      ...theme.type.screenTitle,
      color: theme.colors.textPrimary,
      marginTop: 2,
    },

    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    titleText: { flexShrink: 1 },
    weekStrip: { marginBottom: theme.spacing.lg },

    skeletonGap: { marginTop: theme.spacing.sm },

    passTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      minHeight: 26,
    },
    passKind: { ...theme.type.label, color: theme.colors.textTertiary },
    passInactive: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },

    expiryNote: { marginTop: theme.spacing.sm },
    goodTime: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.md,
    },
    busyHours: { marginTop: theme.spacing.md },
    primaryAction: { marginTop: theme.spacing.lg },
  });
