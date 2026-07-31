import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemedStyles, type Theme } from "../theme";
import { Segmented, type SegmentOption } from "../ui";
import { setLanguage } from "./index";
import type { Language } from "./core";

/**
 * Dil seçimi. `floating` biçim kimlik ekranlarının fotoğraf bandı üzerinde
 * durur, normal biçim Ayarlar'da satır içinde kullanılır.
 */
export function LanguageSwitcher({ floating = false }: { floating?: boolean }) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(switcherStyles);
  const insets = useSafeAreaInsets();
  const active: Language = i18n.resolvedLanguage?.startsWith("tr")
    ? "tr"
    : "en";

  const options: ReadonlyArray<SegmentOption<Language>> = floating
    ? [
        { value: "tr", label: "TR" },
        { value: "en", label: "EN" },
      ]
    : [
        { value: "tr", label: "Türkçe" },
        { value: "en", label: "English" },
      ];

  return (
    <View
      style={[floating && styles.floating, floating && { top: insets.top + 8 }]}
    >
      <Segmented
        options={options}
        value={active}
        onChange={(next) => void setLanguage(next)}
        accessibilityLabel={t("Dil")}
      />
    </View>
  );
}

const switcherStyles = (theme: Theme) =>
  StyleSheet.create({
    floating: {
      position: "absolute",
      zIndex: 20,
      right: theme.spacing.md,
      width: 128,
      borderRadius: theme.radius.input,
      // Fotoğraf bandının üstünde okunur kalması için kendi zemini var.
      backgroundColor: theme.colors.surface,
      ...theme.shadows.plate,
    },
  });
