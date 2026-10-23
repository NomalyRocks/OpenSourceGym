import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemedStyles, type Theme } from "../theme";
import { Segmented, type SegmentOption } from "../ui";
import { setLanguage } from "./index";
import type { Language } from "./core";

const FLOATING_OPTIONS: ReadonlyArray<SegmentOption<Language>> = [
  { value: "tr", label: "TR" },
  { value: "en", label: "EN" },
];

const SETTINGS_OPTIONS: ReadonlyArray<SegmentOption<Language>> = [
  { value: "tr", label: "Türkçe" },
  { value: "en", label: "English" },
];

/**
 * Language selection. The `floating` variant is a compact glass toggle over
 * the halftone band on auth screens; the regular variant is used inline in
 * Settings.
 */
export function LanguageSwitcher({ floating = false }: { floating?: boolean }) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(switcherStyles);
  const insets = useSafeAreaInsets();
  const active: Language = i18n.resolvedLanguage?.startsWith("tr")
    ? "tr"
    : "en";

  if (!floating) {
    return (
      <Segmented
        options={SETTINGS_OPTIONS}
        value={active}
        onChange={(next) => void setLanguage(next)}
        accessibilityLabel={t("Language")}
      />
    );
  }

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t("Language")}
      style={[styles.glass, { top: insets.top + 8 }]}
    >
      {FLOATING_OPTIONS.map((option) => {
        const selected = option.value === active;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => void setLanguage(option.value)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={[styles.segment, selected && styles.segmentActive]}
          >
            <Text
              maxFontSizeMultiplier={1.2}
              style={[styles.label, selected && styles.labelActive]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const switcherStyles = (theme: Theme) =>
  StyleSheet.create({
    // Same top and height as the band's back button so they read as one row.
    glass: {
      position: "absolute",
      zIndex: 20,
      right: theme.spacing.md,
      height: 36,
      flexDirection: "row",
      alignItems: "stretch",
      padding: 3,
      borderRadius: 18,
      backgroundColor: "rgba(255,255,255,0.14)",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "rgba(255,255,255,0.32)",
    },
    segment: {
      minWidth: 38,
      paddingHorizontal: theme.spacing.xs,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentActive: { backgroundColor: "#FFFFFF" },
    label: {
      ...theme.type.label,
      color: "#FFFFFF",
      opacity: 0.75,
    },
    labelActive: { color: "#0055FF", opacity: 1 },
  });
