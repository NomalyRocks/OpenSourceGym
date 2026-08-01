import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MySubscription } from "@opengym/shared";
import { api } from "../lib/api";
import { fetchAttendance, type AttendanceDay } from "../lib/attendance";
import {
  CalendarGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
} from "../components/icons";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import {
  EmptyState,
  Plate,
  ScreenHeader,
  ScrollScreen,
  SectionHeading,
  Skeleton,
  StatusMessage,
} from "../ui";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

/** Hafta pazartesi başlar — uygulamanın birincil yerelinin (tr) düzeni. */
const WEEK_START = 1;

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

interface DayCell {
  date: Date;
  key: string;
  inMonth: boolean;
}

/** Ayı, kenarları komşu aylardan tamamlanmış 7'lik satırlara böler. */
function buildGrid(month: Date): DayCell[] {
  const first = startOfMonth(month);
  const leading = (first.getDay() - WEEK_START + 7) % 7;
  const cells: DayCell[] = [];
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1 - leading);

  // 6 satır × 7 gün: ay uzunluğu değişse de ızgara yüksekliği sabit kalır,
  // aylar arasında geçerken yerleşim zıplamaz.
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + index,
    );
    cells.push({
      date,
      key: dayKey(date),
      inMonth: date.getMonth() === month.getMonth(),
    });
  }
  return cells;
}

export function Calendar() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(calendarStyles);
  const locale = dateLocale(i18n.resolvedLanguage);

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState<string>(() => dayKey(new Date()));
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );
  const [attendance, setAttendance] = useState<AttendanceDay[]>([]);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [attendanceLoaded, setAttendanceLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const todayKey = dayKey(new Date());
  const grid = useMemo(() => buildGrid(month), [month]);

  const load = useCallback(async () => {
    const cells = buildGrid(month);
    const monthDays = cells.filter((cell) => cell.inMonth);
    const from = monthDays[0]?.key;
    const to = monthDays[monthDays.length - 1]?.key;

    const [subscriptionResult, attendanceResult] = await Promise.allSettled([
      api<MySubscription>("/api/me/subscription"),
      from && to
        ? fetchAttendance({ from, to })
        : Promise.resolve({ days: [], timeZone: "" }),
    ]);

    if (subscriptionResult.status === "fulfilled") {
      setSubscription(subscriptionResult.value);
      setSubscriptionError(null);
    } else {
      setSubscriptionError(
        errorMessage(subscriptionResult.reason, t, "Üyelik bilgisi alınamadı."),
      );
    }
    setSubscriptionLoaded(true);

    if (attendanceResult.status === "fulfilled") {
      setAttendance(attendanceResult.value.days);
      setAttendanceError(null);
    } else {
      setAttendance([]);
      setAttendanceError(
        errorMessage(attendanceResult.reason, t, "Geliş geçmişi alınamadı."),
      );
    }
    setAttendanceLoaded(true);
  }, [month, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const attendanceByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of attendance) map.set(day.date, day.entries);
    return map;
  }, [attendance]);

  const membership = useMemo(() => {
    if (!subscription?.startsAt || !subscription.endsAt) return null;
    return {
      start: dayKey(new Date(subscription.startsAt)),
      end: dayKey(new Date(subscription.endsAt)),
    };
  }, [subscription]);

  const inMembership = useCallback(
    (key: string) =>
      membership != null && key >= membership.start && key <= membership.end,
    [membership],
  );

  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2024-01-01 bir pazartesidir; hafta başlangıcından itibaren yedi gün.
    return Array.from({ length: 7 }, (_, index) =>
      formatter.format(new Date(2024, 0, 1 + index)),
    );
  }, [locale]);

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
      }).format(month),
    [locale, month],
  );

  const selectedDate = useMemo(() => {
    const [year, monthPart, day] = selected.split("-").map(Number);
    return new Date(year ?? 1970, (monthPart ?? 1) - 1, day ?? 1);
  }, [selected]);

  const selectedLabel = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(selectedDate);
  const selectedEntries = attendanceByDay.get(selected) ?? 0;

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <ScreenHeader
        title={t("Takvim")}
        subtitle={t("Üyelik dönemini ve salon geçmişini gün gün gör.")}
      />

      <StatusMessage
        text={subscriptionError ?? attendanceError}
        actionLabel={t("Tekrar dene")}
        onAction={() => void load()}
      />

      <Plate padded={false}>
        <View style={styles.monthBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Önceki ay")}
            onPress={() => setMonth((current) => addMonths(current, -1))}
            style={({ pressed }) => [
              styles.monthNav,
              pressed && styles.pressed,
            ]}
          >
            <ChevronLeftGlyph size={20} color={theme.colors.textPrimary} />
          </Pressable>
          <Text accessibilityRole="header" style={styles.monthLabel}>
            {monthLabel}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Sonraki ay")}
            onPress={() => setMonth((current) => addMonths(current, 1))}
            style={({ pressed }) => [
              styles.monthNav,
              pressed && styles.pressed,
            ]}
          >
            <ChevronRightGlyph size={20} color={theme.colors.textPrimary} />
          </Pressable>
        </View>

        <View style={styles.weekdays}>
          {weekdayLabels.map((label, index) => (
            <Text key={index} style={styles.weekday} numberOfLines={1}>
              {label}
            </Text>
          ))}
        </View>

        {!subscriptionLoaded || !attendanceLoaded ? (
          <View style={styles.gridLoading}>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} height={40} radius={theme.radius.small} />
            ))}
          </View>
        ) : (
          <View style={styles.grid}>
            {grid.map((cell) => {
              const covered = inMembership(cell.key);
              const isToday = cell.key === todayKey;
              const isSelected = cell.key === selected;
              const entries = attendanceByDay.get(cell.key) ?? 0;
              // Geliş yalnızca ayın kendi günlerinde işaretlenir: komşu ay
              // günleri için veri çekilmiyor, yeşil kenar boşluğu yanıltırdı.
              const visited = entries > 0 && cell.inMonth;
              const isBoundary =
                membership != null &&
                (cell.key === membership.start || cell.key === membership.end);

              return (
                <Pressable
                  key={cell.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={[
                    new Intl.DateTimeFormat(locale, {
                      day: "numeric",
                      month: "long",
                    }).format(cell.date),
                    visited ? t("{{n}} geliş", { n: entries }) : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  onPress={() => setSelected(cell.key)}
                  // Geliş, üyelik/bugün/seçim katmanlarının HEPSİNİN üstüne
                  // yazar: bu katmanlar vurgu rengini taşıdığından altta
                  // kalsaydı gelinen gün mavi görünür, sinyal kaybolurdu.
                  style={({ pressed }) => [
                    styles.cell,
                    covered && cell.inMonth && styles.cellCovered,
                    isBoundary && cell.inMonth && styles.cellBoundary,
                    isToday && styles.cellToday,
                    isSelected && styles.cellSelected,
                    visited && styles.cellVisited,
                    visited && isToday && styles.cellVisitedToday,
                    visited && isSelected && styles.cellVisitedSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.cellLabel,
                      !cell.inMonth && styles.cellLabelMuted,
                      visited && styles.cellLabelVisited,
                      isSelected && styles.cellLabelSelected,
                    ]}
                  >
                    {cell.date.getDate()}
                  </Text>
                  <View
                    style={[
                      styles.cellDot,
                      visited && styles.cellDotOn,
                      visited && isSelected && styles.cellDotOnSelected,
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, styles.legendCovered]} />
            <Text style={styles.legendLabel}>{t("Üyelik dönemi")}</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, styles.legendToday]} />
            <Text style={styles.legendLabel}>{t("Bugün")}</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, styles.legendVisited]} />
            <Text style={styles.legendLabel}>{t("Geliş")}</Text>
          </View>
        </View>
      </Plate>

      <View style={styles.detail}>
        <SectionHeading title={selectedLabel} />
        <Plate>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t("Üyelik")}</Text>
            <Text style={styles.detailValue}>
              {membership == null
                ? t("Tanımlı değil")
                : inMembership(selected)
                  ? t("Kapsam içinde")
                  : t("Kapsam dışında")}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t("Geliş")}</Text>
            <Text
              style={[
                styles.detailValue,
                selectedEntries > 0 && styles.detailValueVisited,
              ]}
            >
              {attendanceError != null
                ? "—"
                : selectedEntries > 0
                  ? t("{{n}} kayıt", { n: selectedEntries })
                  : t("Geliş yok")}
            </Text>
          </View>
        </Plate>
      </View>

      {attendanceLoaded &&
      attendanceError == null &&
      attendance.length === 0 ? (
        <EmptyState
          icon={<CalendarGlyph size={24} color={theme.colors.textTertiary} />}
          title={t("Bu ay geliş kaydın yok")}
          body={t(
            "Turnikeden her geçişin bu takvimde yeşil işaretlenir. Antrenmana başladığında günler burada dolmaya başlar.",
          )}
        />
      ) : null}
    </ScrollScreen>
  );
}

const calendarStyles = (theme: Theme) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },

    monthBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.xs,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.xs,
    },
    monthNav: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.control,
      alignItems: "center",
      justifyContent: "center",
    },
    monthLabel: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
      flex: 1,
      textAlign: "center",
    },

    weekdays: {
      flexDirection: "row",
      paddingHorizontal: theme.spacing.xs,
      paddingBottom: theme.spacing.xxs,
    },
    weekday: {
      ...theme.type.micro,
      color: theme.colors.textTertiary,
      flex: 1,
      textAlign: "center",
      textTransform: "capitalize",
    },

    gridLoading: {
      paddingHorizontal: theme.spacing.xs,
      paddingBottom: theme.spacing.sm,
      gap: 4,
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: theme.spacing.xs,
      paddingBottom: theme.spacing.xs,
    },
    cell: {
      width: `${100 / 7}%`,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.small,
      borderWidth: 1,
      borderColor: "transparent",
      gap: 2,
    },
    cellCovered: { backgroundColor: theme.colors.accentSurface },
    // Geliş, üyelik tonunun üzerine yazar: gün gerçekten kullanıldıysa takvimde
    // öne çıkan sinyal budur.
    cellVisited: {
      backgroundColor: theme.colors.successSurface,
      borderColor: theme.colors.success,
    },
    // Bugün gelinmişse yeşil kalır; "bugün" işareti kenar kalınlığına düşer.
    // Kenar içeriye çizilir, hücre ölçüsü değişmez.
    cellVisitedToday: { borderWidth: 2 },
    // Seçili gün gelinmişse zemin de yeşile döner: vurgu mavisi burada gelişi
    // gizlerdi. Yazı/nokta `onAccent` — jeton hem vurgu hem başarı renginin
    // üstünde okunacak polariteye sahip.
    cellVisitedSelected: {
      backgroundColor: theme.colors.success,
      borderColor: theme.colors.success,
    },
    cellBoundary: { borderColor: theme.colors.accentBorder },
    cellToday: { borderColor: theme.colors.accent },
    cellSelected: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    cellLabel: {
      ...theme.type.supporting,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
    },
    cellLabelMuted: { color: theme.colors.textDisabled },
    cellLabelVisited: { color: theme.colors.success },
    cellLabelSelected: { color: theme.colors.onAccent },
    cellDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: "transparent",
    },
    cellDotOn: { backgroundColor: theme.colors.success },
    // Seçili gün zemini vurgu rengine döner; yeşil nokta orada okunmaz.
    cellDotOnSelected: { backgroundColor: theme.colors.onAccent },

    legend: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outline,
    },
    legendItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    legendSwatch: {
      width: 14,
      height: 14,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: "transparent",
    },
    legendCovered: { backgroundColor: theme.colors.accentSurface },
    legendToday: { borderColor: theme.colors.accent },
    legendVisited: {
      backgroundColor: theme.colors.successSurface,
      borderColor: theme.colors.success,
    },
    legendLabel: { ...theme.type.label, color: theme.colors.textSecondary },

    detail: { marginTop: theme.spacing.xl },
    detailRow: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    detailLabel: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
    detailValue: {
      ...theme.type.supporting,
      fontWeight: "600",
      color: theme.colors.textPrimary,
      flexShrink: 1,
      textAlign: "right",
    },
    detailValueVisited: { color: theme.colors.success },
  });
