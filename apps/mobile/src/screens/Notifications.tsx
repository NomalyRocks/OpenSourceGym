import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import {
  AlertGlyph,
  BellGlyph,
  CheckGlyph,
  InfoGlyph,
} from "../components/icons";
import {
  useTheme,
  useThemedStyles,
  type Theme,
  type ThemeColors,
} from "../theme";
import {
  Divider,
  EmptyState,
  Plate,
  ScreenHeader,
  ScrollScreen,
  Skeleton,
  StatusMessage,
  useEnter,
} from "../ui";
import { dateLocale } from "../i18n/format";
import type {
  NotificationCenter,
  NotificationDescriptor,
  NotificationTone,
} from "../lib/notifications";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toneColor(colors: ThemeColors, tone: NotificationTone): string {
  switch (tone) {
    case "success":
      return colors.success;
    case "warning":
      return colors.warning;
    case "error":
      return colors.error;
    default:
      return colors.accent;
  }
}

function ToneIcon({ tone, color }: { tone: NotificationTone; color: string }) {
  if (tone === "success") return <CheckGlyph size={18} color={color} />;
  if (tone === "warning" || tone === "error") {
    return <AlertGlyph size={18} color={color} />;
  }
  return <InfoGlyph size={18} color={color} />;
}

/** Göreli zaman; gün eşiğini geçince mutlak tarihe düşer. */
function useRelativeTime() {
  const { i18n, t } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);

  return (iso: string) => {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Date.now() - then;
    if (diff < MINUTE) return t("Az önce");
    if (diff < HOUR)
      return t("{{n}} dk önce", { n: Math.floor(diff / MINUTE) });
    if (diff < DAY) return t("{{n}} sa önce", { n: Math.floor(diff / HOUR) });
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
    }).format(then);
  };
}

function NotificationRow({
  item,
  index,
  formatTime,
}: {
  item: NotificationDescriptor;
  index: number;
  formatTime: (iso: string) => string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(notificationStyles);
  // Liste öğelerinin sırayla açılması gelen sırayı okutur; ilk beşten sonra
  // gecikme birikmesin diye üst sınır var.
  const enter = useEnter({ delay: Math.min(index, 5) * 45, distance: 8 });
  const color = toneColor(theme.colors, item.tone);

  return (
    <Animated.View style={enter}>
      <View
        accessible
        accessibilityLabel={`${t(item.titleKey, item.params)}. ${t(
          item.bodyKey,
          item.params,
        )}`}
        style={styles.row}
      >
        <View style={[styles.rowIcon, { backgroundColor: `${color}22` }]}>
          <ToneIcon tone={item.tone} color={color} />
        </View>
        <View style={styles.rowCopy}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowTitle}>{t(item.titleKey, item.params)}</Text>
            {item.read ? null : <View style={styles.unreadDot} />}
          </View>
          <Text style={styles.rowBody}>{t(item.bodyKey, item.params)}</Text>
          <Text style={styles.rowTime}>{formatTime(item.at)}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

export function Notifications({
  center,
  onBack,
}: {
  center: NotificationCenter;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(notificationStyles);
  const formatTime = useRelativeTime();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    await center.refresh();
    setRefreshing(false);
  }

  const hasUnread = center.unreadCount > 0;

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <ScreenHeader
        title={t("Bildirimler")}
        onBack={onBack}
        trailing={
          hasUnread ? (
            <Pressable
              accessibilityRole="button"
              onPress={center.markAllRead}
              hitSlop={8}
              style={({ pressed }) => [
                styles.markAll,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.markAllLabel}>
                {t("Tümünü okundu işaretle")}
              </Text>
            </Pressable>
          ) : null
        }
      />

      <StatusMessage
        text={center.error ? t(center.error) : null}
        actionLabel={t("Tekrar dene")}
        onAction={() => void center.refresh()}
      />

      {center.loading && center.items.length === 0 ? (
        <Plate>
          <Skeleton width="52%" height={18} />
          <Skeleton height={14} style={styles.skeletonGap} />
          <Skeleton width="34%" height={12} style={styles.skeletonGap} />
        </Plate>
      ) : center.items.length === 0 ? (
        <EmptyState
          icon={<BellGlyph size={24} color={theme.colors.textTertiary} />}
          title={t("Bildirim yok")}
          body={
            center.serverConnected
              ? t("Üyeliğin ve geçişlerinle ilgili haberler burada belirir.")
              : t(
                  "Üyeliğinle ilgili uyarılar burada belirir. Salon duyuruları bağlandığında onlar da bu listeye düşer.",
                )
          }
        />
      ) : (
        <Plate padded={false}>
          {center.items.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? (
                <Divider inset={theme.spacing.lg + 34 + theme.spacing.sm} />
              ) : null}
              <NotificationRow
                item={item}
                index={index}
                formatTime={formatTime}
              />
            </View>
          ))}
        </Plate>
      )}
    </ScrollScreen>
  );
}

const notificationStyles = (theme: Theme) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },
    markAll: { minHeight: 44, justifyContent: "center", maxWidth: 150 },
    markAllLabel: {
      ...theme.type.label,
      color: theme.colors.accent,
      textAlign: "right",
    },
    skeletonGap: { marginTop: theme.spacing.sm },

    row: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      padding: theme.spacing.lg,
    },
    rowIcon: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.small,
      alignItems: "center",
      justifyContent: "center",
    },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitleLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    rowTitle: {
      ...theme.type.title,
      fontSize: 16,
      lineHeight: 21,
      color: theme.colors.textPrimary,
      flexShrink: 1,
    },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: theme.colors.accent,
    },
    rowBody: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    rowTime: {
      ...theme.type.label,
      fontSize: 12,
      color: theme.colors.textTertiary,
      marginTop: theme.spacing.xs,
    },
  });
