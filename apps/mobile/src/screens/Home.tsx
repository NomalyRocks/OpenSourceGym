import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  MyProfile,
  MyOccupancyResponse,
  MySubscription,
  OccupancyResponse,
} from "@opengym/shared";
import { api } from "../lib/api";
import { fetchAttendance, type AttendanceDay } from "../lib/attendance";
import { buildWeek, dayKey } from "../lib/dateKeys";
import { Avatar } from "../components/Avatar";
import { GymList } from "../components/GymList";
import { BellGlyph, QrGlyph } from "../components/icons";
import { WeekStrip } from "../components/WeekStrip";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import {
  Badge,
  Button,
  IconButton,
  Meter,
  Plate,
  ScrollScreen,
  SectionHeading,
  Skeleton,
  StatusMessage,
} from "../ui";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

/**
 * Ticket perforation: separates the identity block from the date rail.
 *
 * `borderStyle: "dashed"` is unreliable on a single edge on Android; distributing
 * a fixed number of dots with `space-between` looks consistent at every width.
 */
function Perforation() {
  const styles = useThemedStyles(homeStyles);
  return (
    <View
      style={styles.perforation}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: 26 }).map((_, index) => (
        <View key={index} style={styles.perforationDot} />
      ))}
    </View>
  );
}

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

/** Occupancy of one gym: name, percentage, head count and a coloured meter. */
function GymOccupancy({
  gym,
  showName,
}: {
  gym: OccupancyResponse;
  showName: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(homeStyles);

  const percent =
    gym.ratio != null
      ? Math.max(0, Math.min(100, Math.round(gym.ratio * 100)))
      : null;
  const tone =
    percent == null
      ? "neutral"
      : percent > 90
        ? "error"
        : percent >= 70
          ? "warning"
          : "success";
  const color =
    tone === "error"
      ? theme.colors.error
      : tone === "warning"
        ? theme.colors.warning
        : tone === "success"
          ? theme.colors.success
          : theme.colors.textTertiary;
  const label =
    percent == null
      ? t("Unknown")
      : percent > 90
        ? t("Busy")
        : percent >= 70
          ? t("Moderate")
          : t("Quiet");

  return (
    <View style={styles.gymOccupancy}>
      <View style={styles.gymOccupancyHeader}>
        {showName ? (
          <Text style={styles.gymOccupancyName} numberOfLines={1}>
            {gym.gymName}
          </Text>
        ) : null}
        <Badge label={label} tone={tone} />
      </View>
      <View style={styles.occupancyRow}>
        <Text style={styles.occupancyPercent}>
          {percent ?? "—"}
          {percent == null ? null : (
            <Text style={styles.occupancyPercentUnit}>%</Text>
          )}
        </Text>
        <Text style={styles.occupancyPeople}>
          {gym.capacity != null
            ? t("{{inside}} of {{capacity}} people inside", {
                inside: gym.inside,
                capacity: gym.capacity,
              })
            : t("{{inside}} people inside", { inside: gym.inside })}
        </Text>
      </View>
      <Meter
        ratio={percent == null ? null : percent / 100}
        color={color}
        label={gym.gymName}
        valueText={label}
      />
    </View>
  );
}

export function Home({
  userName,
  onOpenQr,
  onOpenNotifications,
  onOpenProfile,
  unreadCount = 0,
}: {
  userName: string;
  onOpenQr: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  unreadCount?: number;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(homeStyles);
  const locale = dateLocale(i18n.resolvedLanguage);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse[]>([]);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(false);
  const [occupancyLoaded, setOccupancyLoaded] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );
  const [occupancyError, setOccupancyError] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceDay[]>([]);
  const [attendanceLoaded, setAttendanceLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  // A ref guards double taps: state updates land after the second press.
  const freezeBusyRef = useRef(false);

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

    if (occupancyResult.status === "fulfilled") {
      setOccupancy(occupancyResult.value.gyms);
      setOccupancyError(null);
    } else {
      setOccupancyError(
        errorMessage(
          occupancyResult.reason,
          t,
          "Occupancy data could not be loaded.",
        ),
      );
    }
    setOccupancyLoaded(true);

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

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // An older API may omit these fields during rollout: no freeze, no button.
  const freeze = subscription?.freeze ?? null;
  const freezeAllowance = subscription?.freezeAllowance ?? null;

  async function changeFreeze(method: "POST" | "DELETE") {
    if (freezeBusyRef.current) return;
    freezeBusyRef.current = true;
    setFreezeBusy(true);
    setFreezeError(null);
    try {
      await api("/api/me/freeze", { method });
      await load();
    } catch (error) {
      setFreezeError(
        errorMessage(
          error,
          t,
          method === "POST"
            ? "The membership could not be frozen. Please try again."
            : "The membership could not be resumed. Please try again.",
        ),
      );
      // The state may have changed server-side (e.g. already frozen).
      void load();
    } finally {
      freezeBusyRef.current = false;
      setFreezeBusy(false);
    }
  }

  function confirmFreeze() {
    if (!freezeAllowance) return;
    const { usedInLastYear, maxPerYear, maxDays } = freezeAllowance;
    Alert.alert(
      t("Freeze membership"),
      [
        t("{{used}} of {{max}} freezes used this year.", {
          used: usedInLastYear,
          max: maxPerYear,
        }),
        t(
          "At most {{days}} days of the freeze are added back to your end date.",
          { days: maxDays },
        ),
        t(
          "Your next turnstile entry ends the freeze automatically, or you can resume it here at any time.",
        ),
      ].join("\n\n"),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Freeze"), onPress: () => void changeFreeze("POST") },
      ],
    );
  }

  function confirmResume() {
    Alert.alert(
      t("Resume membership"),
      t(
        "Your freeze will end now and the frozen days will be added back to your end date.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Resume"), onPress: () => void changeFreeze("DELETE") },
      ],
    );
  }

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
  const remainingDays = subscription?.remainingDays ?? 0;
  // During the final week, the membership plate switches to a warning tone:
  // the information stays in place and only its color changes.
  // A frozen membership is paused, not running out: stay calm and neutral.
  const frozen = freeze != null;
  const expiringSoon = active && !frozen && remainingDays <= 7;

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
          <Text accessibilityRole="header" style={styles.title}>
            {t("At the gym today")}
          </Text>
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

      {/* Membership card—access-pass language: upper identity block, perforated
          divider, and lower date rail. */}
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
      ) : (
        <Plate padded={false}>
          <View style={styles.passTop}>
            <View style={styles.passTopRow}>
              <Text style={styles.passKind}>{t("Membership")}</Text>
              <Badge
                label={
                  frozen ? t("Frozen") : active ? t("Active") : t("Inactive")
                }
                tone={
                  frozen
                    ? "neutral"
                    : active
                      ? expiringSoon
                        ? "warning"
                        : "success"
                      : "error"
                }
              />
            </View>
            <Text style={styles.passName} numberOfLines={2}>
              {userName}
            </Text>

            {active ? (
              <View style={styles.remainingRow}>
                <Text style={styles.remainingValue}>{remainingDays}</Text>
                <Text style={styles.remainingUnit}>{t("Days left")}</Text>
              </View>
            ) : (
              <Text style={styles.passInactive}>
                {t(
                  "You do not have an active membership. Contact gym reception for help.",
                )}
              </Text>
            )}
          </View>

          <Perforation />

          <View style={styles.passBottom}>
            <View style={styles.passDate}>
              <Text style={styles.passDateLabel}>{t("Start")}</Text>
              <Text style={styles.passDateValue}>
                {formatDate(subscription?.startsAt)}
              </Text>
            </View>
            <View style={styles.passDate}>
              <Text style={styles.passDateLabel}>{t("End")}</Text>
              <Text style={styles.passDateValue}>
                {formatDate(subscription?.endsAt)}
              </Text>
            </View>
          </View>

          {active && subscription && subscription.gyms.length > 0 ? (
            <View style={styles.passGyms}>
              <Text style={styles.passDateLabel}>{t("Gyms")}</Text>
              <GymList gyms={subscription.gyms} />
            </View>
          ) : null}
        </Plate>
      )}

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

      {subscriptionLoaded && subscription ? (
        <View style={styles.freezeActions}>
          <StatusMessage text={freezeError} />
          {freeze ? (
            <Button
              title={t("Resume membership")}
              variant="secondary"
              busy={freezeBusy}
              onPress={confirmResume}
            />
          ) : freezeAllowance?.canFreeze === true ? (
            <Button
              title={t("Freeze membership")}
              variant="secondary"
              busy={freezeBusy}
              onPress={confirmFreeze}
            />
          ) : active &&
            freezeAllowance &&
            freezeAllowance.maxPerYear > 0 &&
            freezeAllowance.usedInLastYear >= freezeAllowance.maxPerYear ? (
            <Text style={styles.freezeHint}>
              {t("No freezes left this year.")}
            </Text>
          ) : null}
        </View>
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

      <View style={styles.occupancy}>
        <SectionHeading title={t("Gym occupancy")} />

        {!occupancyLoaded ? (
          <View style={styles.occupancyLoading}>
            <Skeleton width="34%" height={24} />
            <Skeleton height={8} radius={4} />
            <Skeleton width="56%" height={16} />
          </View>
        ) : occupancyError ? (
          <StatusMessage
            text={occupancyError}
            actionLabel={t("Try again")}
            onAction={() => void load()}
          />
        ) : occupancy.length === 0 ? (
          <Text style={styles.occupancyEmpty}>
            {t(
              "No gym occupancy to show. Occupancy appears once you have an active membership.",
            )}
          </Text>
        ) : (
          occupancy.map((gym) => (
            <GymOccupancy key={gym.gymId} gym={gym} showName />
          ))
        )}
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

    weekStrip: { marginBottom: theme.spacing.lg },

    skeletonGap: { marginTop: theme.spacing.sm },

    passTop: { padding: theme.spacing.lg, paddingBottom: theme.spacing.md },
    passTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      minHeight: 26,
    },
    passKind: { ...theme.type.label, color: theme.colors.textTertiary },
    passName: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
      marginTop: theme.spacing.xxs,
    },
    remainingRow: {
      flexDirection: "row",
      alignItems: "baseline",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.md,
    },
    remainingValue: {
      ...theme.type.metric,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
    },
    remainingUnit: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
      paddingBottom: 4,
    },
    passInactive: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },

    perforation: {
      marginHorizontal: theme.spacing.lg,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      overflow: "hidden",
    },
    perforationDot: {
      width: 4,
      height: 2,
      borderRadius: 1,
      backgroundColor: theme.colors.outlineStrong,
    },

    passBottom: {
      flexDirection: "row",
      padding: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      gap: theme.spacing.lg,
    },
    passGyms: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
    },
    passDate: { flex: 1, minWidth: 0 },
    passDateLabel: { ...theme.type.label, color: theme.colors.textTertiary },
    passDateValue: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
      marginTop: 2,
    },

    expiryNote: { marginTop: theme.spacing.sm },
    freezeActions: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },
    freezeHint: {
      ...theme.type.supporting,
      color: theme.colors.textTertiary,
      textAlign: "center",
    },
    primaryAction: { marginTop: theme.spacing.lg },

    occupancy: {
      marginTop: theme.spacing.xxl,
      paddingTop: theme.spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outline,
    },
    occupancyLoading: { gap: theme.spacing.sm },
    occupancyEmpty: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
    gymOccupancy: { marginBottom: theme.spacing.lg },
    gymOccupancyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
    },
    gymOccupancyName: {
      ...theme.type.label,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    occupancyRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    occupancyPercent: {
      ...theme.type.sectionTitle,
      ...tabularNumbers,
      fontSize: 24,
      lineHeight: 30,
      color: theme.colors.textPrimary,
    },
    occupancyPercentUnit: {
      fontSize: 15,
      lineHeight: 20,
      fontWeight: "600",
      color: theme.colors.textSecondary,
    },
    occupancyPeople: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      flex: 1,
    },
  });
