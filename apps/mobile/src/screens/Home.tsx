import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type {
  MyProfile,
  MySubscription,
  OccupancyResponse,
} from "@opengym/shared";
import { api } from "../lib/api";
import { fetchAttendance, type AttendanceDay } from "../lib/attendance";
import { buildWeek, dayKey } from "../lib/dateKeys";
import { Avatar } from "../components/Avatar";
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
 * Bilet perforasyonu: kimlik bloğunu tarih rayından ayırır.
 *
 * `borderStyle: "dashed"` Android'de tek kenarda güvenilir çizilmiyor; sabit
 * sayıda nokta `space-between` ile dağıtılınca her genişlikte aynı görünür.
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
  const theme = useTheme();
  const styles = useThemedStyles(homeStyles);
  const locale = dateLocale(i18n.resolvedLanguage);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(false);
  const [occupancyLoaded, setOccupancyLoaded] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );
  const [occupancyError, setOccupancyError] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceDay[]>([]);
  const [attendanceLoaded, setAttendanceLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
      api<OccupancyResponse>("/api/me/occupancy"),
      weekFrom && weekTo
        ? fetchAttendance({ from: weekFrom, to: weekTo })
        : Promise.resolve({ days: [], timeZone: "" }),
    ]);

    // Profil yalnızca başlıktaki görseli besler; okunamazsa Avatar baş
    // harflere düşer, bu yüzden ayrı bir hata mesajı göstermiyoruz.
    if (profileResult.status === "fulfilled") setProfile(profileResult.value);
    setProfileLoaded(true);

    if (subscriptionResult.status === "fulfilled") {
      setSubscription(subscriptionResult.value);
      setSubscriptionError(null);
    } else {
      setSubscriptionError(
        errorMessage(subscriptionResult.reason, t, "Üyelik bilgisi alınamadı."),
      );
    }
    setSubscriptionLoaded(true);

    if (occupancyResult.status === "fulfilled") {
      setOccupancy(occupancyResult.value);
      setOccupancyError(null);
    } else {
      setOccupancyError(
        errorMessage(occupancyResult.reason, t, "Doluluk bilgisi alınamadı."),
      );
    }
    setOccupancyLoaded(true);

    // Geliş şeridi ikincil bir gösterim: çekilemezse sessizce nötr kalır,
    // Home'un geri kalanını hata banner'ıyla kirletmez.
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

  const occupancyPercent =
    occupancy?.ratio != null
      ? Math.max(0, Math.min(100, Math.round(occupancy.ratio * 100)))
      : null;
  const occupancyTone =
    occupancyPercent == null
      ? "neutral"
      : occupancyPercent > 90
        ? "error"
        : occupancyPercent >= 70
          ? "warning"
          : "success";
  const occupancyColor =
    occupancyTone === "error"
      ? theme.colors.error
      : occupancyTone === "warning"
        ? theme.colors.warning
        : occupancyTone === "success"
          ? theme.colors.success
          : theme.colors.textTertiary;
  const occupancyLabel =
    occupancyPercent == null
      ? t("Bilinmiyor")
      : occupancyPercent > 90
        ? t("Yoğun")
        : occupancyPercent >= 70
          ? t("Orta yoğunluk")
          : t("Sakin");

  const firstName = userName.trim().split(/\s+/)[0] || t("Üye");
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
  // Son bir haftaya girildiğinde üyelik plakası uyarı tonuna geçer: bilgi
  // aynı yerde kalır, rengi değişir.
  const expiringSoon = active && remainingDays <= 7;

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <View style={styles.header}>
        {profileLoaded ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Profil")}
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
            {t("Merhaba, {{name}}", { name: firstName })}
          </Text>
          <Text accessibilityRole="header" style={styles.title}>
            {t("Bugün salonda")}
          </Text>
        </View>
        <IconButton
          label={t("Bildirimler")}
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

      {/* Üyelik kartı — geçiş kartı dili: üst kimlik bloğu, perfore ayraç,
          alt tarih rayı. */}
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
            actionLabel={t("Tekrar dene")}
            onAction={() => void load()}
          />
        </Plate>
      ) : (
        <Plate padded={false}>
          <View style={styles.passTop}>
            <View style={styles.passTopRow}>
              <Text style={styles.passKind}>{t("Üyelik")}</Text>
              <Badge
                label={active ? t("Aktif") : t("Pasif")}
                tone={active ? (expiringSoon ? "warning" : "success") : "error"}
              />
            </View>
            <Text style={styles.passName} numberOfLines={2}>
              {userName}
            </Text>

            {active ? (
              <View style={styles.remainingRow}>
                <Text style={styles.remainingValue}>{remainingDays}</Text>
                <Text style={styles.remainingUnit}>{t("Kalan gün")}</Text>
              </View>
            ) : (
              <Text style={styles.passInactive}>
                {t(
                  "Aktif üyeliğin bulunmuyor. Salon resepsiyonundan destek alabilirsin.",
                )}
              </Text>
            )}
          </View>

          <Perforation />

          <View style={styles.passBottom}>
            <View style={styles.passDate}>
              <Text style={styles.passDateLabel}>{t("Başlangıç")}</Text>
              <Text style={styles.passDateValue}>
                {formatDate(subscription?.startsAt)}
              </Text>
            </View>
            <View style={styles.passDate}>
              <Text style={styles.passDateLabel}>{t("Bitiş")}</Text>
              <Text style={styles.passDateValue}>
                {formatDate(subscription?.endsAt)}
              </Text>
            </View>
          </View>
        </Plate>
      )}

      {expiringSoon ? (
        <StatusMessage
          tone="warning"
          style={styles.expiryNote}
          text={t("Üyeliğin yakında bitiyor; yenilemek için resepsiyona uğra.")}
        />
      ) : null}

      <View style={styles.primaryAction}>
        <Button
          title={t("Turnike QR kodunu tara")}
          onPress={onOpenQr}
          icon={(color) => <QrGlyph size={20} color={color} />}
        />
      </View>

      <View style={styles.occupancy}>
        <SectionHeading
          title={t("Salon doluluğu")}
          trailing={
            occupancyLoaded && !occupancyError ? (
              <Badge label={occupancyLabel} tone={occupancyTone} />
            ) : null
          }
        />

        {!occupancyLoaded ? (
          <View style={styles.occupancyLoading}>
            <Skeleton width="34%" height={24} />
            <Skeleton height={8} radius={4} />
            <Skeleton width="56%" height={16} />
          </View>
        ) : occupancyError ? (
          <StatusMessage
            text={occupancyError}
            actionLabel={t("Tekrar dene")}
            onAction={() => void load()}
          />
        ) : (
          <>
            <View style={styles.occupancyRow}>
              <Text style={styles.occupancyPercent}>
                {occupancyPercent ?? "—"}
                {occupancyPercent == null ? null : (
                  <Text style={styles.occupancyPercentUnit}>%</Text>
                )}
              </Text>
              <Text style={styles.occupancyPeople}>
                {occupancy?.capacity != null
                  ? t("{{inside}} / {{capacity}} kişi içeride", {
                      inside: occupancy.inside,
                      capacity: occupancy.capacity,
                    })
                  : t("{{inside}} kişi içeride", {
                      inside: occupancy?.inside ?? 0,
                    })}
              </Text>
            </View>
            <Meter
              ratio={occupancyPercent == null ? null : occupancyPercent / 100}
              color={occupancyColor}
              label={t("Salon doluluğu")}
              valueText={occupancyLabel}
            />
          </>
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
    // Görsele dokunmak Profil sekmesine geçirir — başlıktaki tek kısayol.
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
    passDate: { flex: 1, minWidth: 0 },
    passDateLabel: { ...theme.type.label, color: theme.colors.textTertiary },
    passDateValue: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
      marginTop: 2,
    },

    expiryNote: { marginTop: theme.spacing.sm },
    primaryAction: { marginTop: theme.spacing.lg },

    occupancy: {
      marginTop: theme.spacing.xxl,
      paddingTop: theme.spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outline,
    },
    occupancyLoading: { gap: theme.spacing.sm },
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
