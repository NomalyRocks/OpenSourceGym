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

/** Çubuğun kendi yüksekliği (iç boşluk + öğe yüksekliği). */
const BAR_HEIGHT = 72;
/** Çubuk ile ekranın alt kenarı arasındaki asgari boşluk. */
const FLOAT_GAP = 12;

/**
 * Yüzen çubuğun içerikten çalacağı dikey pay.
 *
 * `BottomInsetProvider`'a verilir; `Screen` ve `ScrollScreen` bunu alt boşluğa
 * ekler, böylece son satır camın ardında kalmaz.
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
  { id: "home", label: "Ana Sayfa", icon: (c) => <HomeGlyph color={c} /> },
  { id: "calendar", label: "Takvim", icon: (c) => <CalendarGlyph color={c} /> },
  { id: "scan", label: "QR Tara", icon: (c) => <QrGlyph color={c} /> },
  { id: "tools", label: "Araçlar", icon: (c) => <ToolsGlyph color={c} /> },
  { id: "profile", label: "Profil", icon: (c) => <PersonGlyph color={c} /> },
];

/**
 * Yüzen, yumuşak köşeli, yarı saydam sekme çubuğu.
 *
 * Gerçek arka plan bulanıklığı (`backdrop-filter`) React Native 0.86'da yok —
 * `filter` yalnızca elemanın kendi içeriğine uygulanır. Cam etkisi bu yüzden
 * katmanla kuruluyor: yarı saydam yüzey + üst kenarda ışık çizgisi + gölge.
 * İçerik altından geçtiği için yüzey ölü bir levha gibi durmuyor.
 *
 * `expo-blur` eklenirse tek değişiklik: dıştaki `View`'ı
 * `<BlurView intensity={…} tint={theme.name}>` ile sarmak (native rebuild ister).
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

  // Gösterge hapı 4px'lik iç boşluğun içinde kayar.
  const cellWidth = barWidth > 0 ? (barWidth - 8) / tabs.length : 0;

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { bottom: Math.max(insets.bottom, FLOAT_GAP) }]}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      {/* Cam kenarı: üstte içeriden geçen ince ışık çizgisi. */}
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
      // Yarı saydam ama etiketler okunur kalsın diye opaklık yüksek.
      backgroundColor: withAlpha(
        theme.colors.surface,
        theme.name === "dark" ? 0.9 : 0.88,
      ),
      // Koyuda kenarlık, açıkta gölge — ikisi birden "hayalet kart" olurdu.
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
    // Seçili sekmenin ardında kayan yumuşak hap.
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
