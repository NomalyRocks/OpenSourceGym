import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { MySubscriptionGym, OccupancyResponse } from "@opengym/shared";
import { occupancyLevel } from "../lib/occupancy";
import { useTabSwipeLock } from "../lib/tabSwipeLock";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import { Badge, Plate } from "../ui";
import { occupancyColor } from "./GymCard";

/**
 * Full-width paging cards — one gym per page — with tappable page dots. The
 * scroller breaks out of the screen gutter so each page is exactly the window
 * wide and neighbours are fully off-screen. A single gym has no dots.
 */
export function MembershipPager({
  gyms,
  occupancy,
  badge,
  formatDate,
  onPageChange,
}: {
  gyms: MySubscriptionGym[];
  occupancy: OccupancyResponse[];
  badge: { label: string; tone: "success" | "warning" | "neutral" | "error" };
  formatDate: (value?: string | null) => string;
  /** Fired when the visible page changes (swipe or dot tap). */
  onPageChange?: (index: number) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(pagerStyles);
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const multiple = gyms.length > 1;
  const tabLock = useTabSwipeLock();
  const held = useRef(false);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const unlock = useCallback(() => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
    if (!held.current) return;
    held.current = false;
    tabLock.unlock();
  }, [tabLock]);

  // Safety net: a missed end event must never leave the tabs locked.
  const armWatchdog = useCallback(() => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(unlock, 1500);
  }, [unlock]);

  const lock = useCallback(() => {
    armWatchdog();
    if (held.current) return;
    held.current = true;
    tabLock.lock();
  }, [armWatchdog, tabLock]);

  useEffect(() => unlock, [unlock]);
  // With a single gym there is nothing to page: tab swipes work over the card.
  useEffect(() => {
    if (!multiple) unlock();
  }, [multiple, unlock]);

  return (
    <View>
      <View
        style={styles.breakout}
        onTouchStart={multiple ? lock : undefined}
        onTouchEnd={multiple ? unlock : undefined}
        onTouchCancel={multiple ? unlock : undefined}
      >
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={multiple}
          nestedScrollEnabled
          directionalLockEnabled
          onScroll={multiple ? armWatchdog : undefined}
          scrollEventThrottle={64}
          onScrollEndDrag={(event) => {
            // No momentum follows a drag that ends at rest on a page boundary.
            const x = event.nativeEvent.contentOffset.x;
            if (Math.abs(event.nativeEvent.velocity?.x ?? 0) < 0.05) {
              const next = Math.round(x / width);
              if (Math.abs(x - next * width) < 1) unlock();
            }
          }}
          onMomentumScrollEnd={(event) => {
            unlock();
            const next = Math.round(event.nativeEvent.contentOffset.x / width);
            const clamped = Math.max(0, Math.min(gyms.length - 1, next));
            setPage(clamped);
            onPageChange?.(clamped);
          }}
        >
          {gyms.map((gym, index) => {
            const gymOccupancy = occupancy.find((o) => o.gymId === gym.id);
            const level = occupancyLevel(gymOccupancy?.ratio);
            const showChip = gymOccupancy != null && level.percent != null;
            return (
              <View
                key={gym.id}
                accessible
                accessibilityLabel={
                  multiple
                    ? t("Gym {{index}} of {{count}}", {
                        index: index + 1,
                        count: gyms.length,
                      })
                    : undefined
                }
                style={[styles.page, { width }]}
              >
                <Plate style={styles.card}>
                  <View style={styles.topRow}>
                    <Text style={styles.name} numberOfLines={1}>
                      {gym.name}
                    </Text>
                    <Badge label={badge.label} tone={badge.tone} />
                  </View>
                  <View style={styles.daysRow}>
                    <Text style={styles.days}>{gym.remainingDays ?? 0}</Text>
                    <Text style={styles.daysUnit}>{t("Days left")}</Text>
                  </View>
                  <View style={styles.bottomRow}>
                    <Text style={styles.ends} numberOfLines={1}>
                      {t("Ends {{date}}", { date: formatDate(gym.endsAt) })}
                    </Text>
                    {showChip ? (
                      <View style={styles.chip}>
                        <View
                          style={[
                            styles.chipDot,
                            {
                              backgroundColor: occupancyColor(
                                theme,
                                level.tone,
                              ),
                            },
                          ]}
                        />
                        <Text style={styles.chipText} numberOfLines={1}>
                          {`${t(level.label)} · ${level.percent}%`}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </Plate>
              </View>
            );
          })}
        </ScrollView>
      </View>

      {multiple ? (
        <View style={styles.dots}>
          {gyms.map((gym, index) => (
            <Pressable
              key={gym.id}
              accessibilityRole="button"
              accessibilityLabel={t("Gym {{index}} of {{count}}", {
                index: index + 1,
                count: gyms.length,
              })}
              hitSlop={10}
              onPress={() => {
                scroller.current?.scrollTo({
                  x: index * width,
                  animated: true,
                });
                setPage(index);
                onPageChange?.(index);
              }}
              style={[styles.dot, index === page && styles.dotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const pagerStyles = (theme: Theme) =>
  StyleSheet.create({
    breakout: { marginHorizontal: -theme.spacing.gutter },
    page: { paddingHorizontal: theme.spacing.gutter },
    card: { flex: 1 },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      minHeight: 26,
    },
    name: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
      flex: 1,
      flexShrink: 1,
    },
    daysRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.md,
    },
    days: {
      ...theme.type.metric,
      ...tabularNumbers,
      color: theme.colors.textPrimary,
    },
    daysUnit: { ...theme.type.body, color: theme.colors.textSecondary },
    bottomRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
    ends: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textTertiary,
      flexShrink: 1,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 0,
    },
    chipDot: { width: 8, height: 8, borderRadius: 4 },
    chipText: { ...theme.type.label, color: theme.colors.textSecondary },
    dots: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 6,
      marginTop: theme.spacing.sm,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.colors.outlineStrong,
    },
    dotActive: { width: 16, backgroundColor: theme.colors.accent },
  });
