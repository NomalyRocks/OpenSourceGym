import { useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemedStyles, withAlpha, type Theme } from "../theme";
import type { MobileTranslationKey } from "../i18n/resources";
import { GymGlyph, HomeGlyph, PersonGlyph, QrGlyph, ToolsGlyph } from "./icons";

export type AppTab = "home" | "gyms" | "scan" | "tools" | "profile";

/** The bar's own height (padding + item height). */
const BAR_HEIGHT = 72;
/** Minimum gap between the bar and the bottom edge of the screen. */
const FLOAT_GAP = 12;

/**
 * Vertical space reserved for the floating bar.
 *
 * Passed to `BottomInsetProvider`; `Screen` and `ScrollScreen` add it to their
 * bottom spacing so the last row does not remain behind the bar.
 */
export function useTabBarSpace(): number {
  const insets = useSafeAreaInsets();
  return BAR_HEIGHT + Math.max(insets.bottom, FLOAT_GAP) + FLOAT_GAP;
}

/** Tab order shared with the pager in App.tsx. */
export const TAB_ORDER: readonly AppTab[] = [
  "home",
  "gyms",
  "scan",
  "tools",
  "profile",
];

const tabs: ReadonlyArray<{
  id: AppTab;
  label: MobileTranslationKey;
  icon: (color: string) => ReactNode;
}> = [
  { id: "home", label: "Home", icon: (c) => <HomeGlyph color={c} /> },
  {
    id: "gyms",
    label: "Gyms",
    icon: (c) => <GymGlyph color={c} />,
  },
  { id: "scan", label: "Scan QR", icon: (c) => <QrGlyph color={c} /> },
  { id: "tools", label: "Tools", icon: (c) => <ToolsGlyph color={c} /> },
  { id: "profile", label: "Profile", icon: (c) => <PersonGlyph color={c} /> },
];

/**
 * Floating, softly rounded, opaque tab bar.
 *
 * Opaque `surface` with a hairline border, a faint highlight along the top
 * edge and the raised shadow; it floats above the content instead of blending in.
 */
export function BottomTabBar({
  activeTab,
  onTabChange,
  scrollX,
  pageWidth,
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  /** Horizontal offset of the tab pager; the indicator follows it live. */
  scrollX: Animated.Value;
  /** Width of one pager page. */
  pageWidth: number;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(tabBarStyles);
  const insets = useSafeAreaInsets();
  const [barWidth, setBarWidth] = useState(0);

  // The indicator pill slides within the 4 px inset.
  const cellWidth = barWidth > 0 ? (barWidth - 8) / tabs.length : 0;

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { bottom: Math.max(insets.bottom, FLOAT_GAP) }]}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      {/* Top edge: a thin internal highlight across the top. */}
      <View style={styles.rim} pointerEvents="none" />

      {cellWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              width: cellWidth,
              transform: [
                {
                  translateX: scrollX.interpolate({
                    inputRange: tabs.map((_, index) => index * pageWidth),
                    outputRange: tabs.map((_, index) => index * cellWidth),
                    extrapolate: "clamp",
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}

      {tabs.map((tab) => {
        const selected = tab.id === activeTab;
        const color = selected
          ? theme.colors.accent
          : theme.colors.textTertiary;

        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={t(tab.label)}
            accessibilityState={{ selected }}
            onPress={() => onTabChange(tab.id)}
            style={({ pressed }) => [
              styles.item,
              pressed && styles.itemPressed,
            ]}
          >
            {tab.icon(color)}
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
              style={[styles.label, { color }]}
            >
              {t(tab.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const tabBarStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: {
      position: "absolute",
      left: theme.spacing.md,
      right: theme.spacing.md,
      height: BAR_HEIGHT,
      flexDirection: "row",
      alignItems: "stretch",
      padding: 4,
      borderRadius: 24,
      // Fully opaque so content scrolling underneath never shows through.
      backgroundColor: theme.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.outline,
      ...theme.shadows.raised,
    },
    rim: {
      position: "absolute",
      top: 0,
      left: 20,
      right: 20,
      height: 1,
      borderRadius: 1,
      backgroundColor: withAlpha(
        theme.colors.textPrimary,
        theme.name === "dark" ? 0.14 : 0.06,
      ),
    },
    // Soft pill that slides behind the selected tab.
    indicator: {
      position: "absolute",
      top: 4,
      left: 4,
      bottom: 4,
      borderRadius: 20,
      backgroundColor: theme.colors.accentSurface,
    },
    item: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      borderRadius: 20,
      paddingHorizontal: 2,
    },
    itemPressed: { opacity: 0.6 },
    label: {
      ...theme.type.micro,
      fontSize: 11,
      letterSpacing: 0,
      fontWeight: "600",
    },
  });
