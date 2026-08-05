import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemedStyles, withAlpha, type Theme } from "../theme";
import type { MobileTranslationKey } from "../i18n/resources";
import { easing, useReducedMotion } from "../ui";
import {
  CalendarGlyph,
  HomeGlyph,
  PersonGlyph,
  QrGlyph,
  ToolsGlyph,
} from "./icons";

export type AppTab = "home" | "calendar" | "scan" | "tools" | "profile";

/** The bar's own height (padding + item height). */
const BAR_HEIGHT = 72;
/** Minimum gap between the bar and the bottom edge of the screen. */
const FLOAT_GAP = 12;

/**
 * Vertical space reserved for the floating bar.
 *
 * Passed to `BottomInsetProvider`; `Screen` and `ScrollScreen` add it to their
 * bottom spacing so the last row does not remain behind the glass.
 */
export function useTabBarSpace(): number {
  const insets = useSafeAreaInsets();
  return BAR_HEIGHT + Math.max(insets.bottom, FLOAT_GAP) + FLOAT_GAP;
}

const tabs: ReadonlyArray<{
  id: AppTab;
  label: MobileTranslationKey;
  icon: (color: string) => ReactNode;
}> = [
  { id: "home", label: "Home", icon: (c) => <HomeGlyph color={c} /> },
  {
    id: "calendar",
    label: "Calendar",
    icon: (c) => <CalendarGlyph color={c} />,
  },
  { id: "scan", label: "Scan QR", icon: (c) => <QrGlyph color={c} /> },
  { id: "tools", label: "Tools", icon: (c) => <ToolsGlyph color={c} /> },
  { id: "profile", label: "Profile", icon: (c) => <PersonGlyph color={c} /> },
];

/**
 * Floating, softly rounded, translucent tab bar.
 *
 * True background blur (`backdrop-filter`) is unavailable in React Native 0.86—
 * `filter` applies only to the element's own content. The glass effect therefore
 * uses layers: a translucent surface, a highlight along the top edge, and a shadow.
 * Content passing underneath keeps the surface from looking like a lifeless slab.
 *
 * If `expo-blur` is added, the only change is wrapping the outer `View` with
 * `<BlurView intensity={…} tint={theme.name}>` (requires a native rebuild).
 */
export function BottomTabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(tabBarStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [barWidth, setBarWidth] = useState(0);
  const indicator = useRef(new Animated.Value(0)).current;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTab),
  );

  useEffect(() => {
    if (reduced) {
      indicator.setValue(activeIndex);
      return;
    }
    const animation = Animated.timing(indicator, {
      toValue: activeIndex,
      duration: theme.motion.standard,
      easing: easing.inOut,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [activeIndex, indicator, reduced, theme.motion.standard]);

  // The indicator pill slides within the 4 px inset.
  const cellWidth = barWidth > 0 ? (barWidth - 8) / tabs.length : 0;

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { bottom: Math.max(insets.bottom, FLOAT_GAP) }]}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      {/* Glass edge: a thin internal highlight across the top. */}
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
                  translateX: indicator.interpolate({
                    inputRange: tabs.map((_, index) => index),
                    outputRange: tabs.map((_, index) => index * cellWidth),
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
      // Translucent, but opaque enough to keep labels readable.
      backgroundColor: withAlpha(
        theme.colors.surface,
        theme.name === "dark" ? 0.9 : 0.88,
      ),
      // Border in dark mode, shadow in light mode—both would look like a ghost card.
      borderWidth: theme.name === "dark" ? StyleSheet.hairlineWidth : 0,
      borderColor: withAlpha(theme.colors.textPrimary, 0.12),
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
