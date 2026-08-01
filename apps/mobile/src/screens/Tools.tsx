import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { CalculatorGlyph, ChevronRightGlyph } from "../components/icons";
import { useTheme, useThemedStyles, type Theme } from "../theme";
import { ScreenHeader, ScrollScreen } from "../ui";
import { CalorieCalculator } from "./CalorieCalculator";

export function Tools({
  onFullscreenChange,
}: {
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(toolsStyles);
  const { width, fontScale } = useWindowDimensions();
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const singleColumn = width < 360 || fontScale > 1.3;

  useEffect(
    () => () => {
      onFullscreenChange(false);
    },
    [onFullscreenChange],
  );

  function openCalculator() {
    setCalculatorOpen(true);
    onFullscreenChange(true);
  }

  function closeCalculator() {
    setCalculatorOpen(false);
    onFullscreenChange(false);
  }

  if (calculatorOpen) {
    return <CalorieCalculator onClose={closeCalculator} />;
  }

  return (
    <ScrollScreen>
      <ScreenHeader
        title={t("Araçlar")}
        subtitle={t(
          "Antrenman hedeflerini planlamana yardımcı olan hesaplayıcılar.",
        )}
      />

      <View style={styles.grid}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Günlük kalori ihtiyacı")}
          accessibilityHint={t(
            "Kalori ve makro hesaplama akışını tam ekranda açar.",
          )}
          onPress={openCalculator}
          style={({ pressed }) => [
            styles.card,
            singleColumn && styles.cardSingle,
            pressed && styles.cardPressed,
          ]}
        >
          <View style={styles.iconWell}>
            <CalculatorGlyph size={27} color={theme.colors.accent} />
          </View>
          <View style={styles.cardCopy}>
            <Text style={styles.cardTitle}>{t("Günlük kalori ihtiyacı")}</Text>
            <Text style={styles.cardBody}>
              {t("Hedef kalorilerini ve günlük makrolarını tahmin et.")}
            </Text>
          </View>
          <View style={styles.cardArrow}>
            <ChevronRightGlyph size={18} color={theme.colors.textTertiary} />
          </View>
        </Pressable>
      </View>
    </ScrollScreen>
  );
}

const toolsStyles = (theme: Theme) =>
  StyleSheet.create({
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.md,
    },
    card: {
      width: "47.5%",
      minHeight: 184,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.card,
      backgroundColor: theme.colors.surface,
      borderWidth: theme.name === "dark" ? StyleSheet.hairlineWidth : 0,
      borderColor: theme.colors.outline,
      ...theme.shadows.plate,
    },
    cardSingle: { width: "100%", minHeight: 158 },
    cardPressed: {
      backgroundColor: theme.colors.surfaceRaised,
      transform: [{ scale: 0.985 }],
    },
    iconWell: {
      width: 52,
      height: 52,
      borderRadius: theme.radius.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.accentSurface,
      marginBottom: theme.spacing.lg,
    },
    cardCopy: { flex: 1 },
    cardTitle: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
    },
    cardBody: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xxs,
    },
    cardArrow: {
      position: "absolute",
      right: theme.spacing.md,
      top: theme.spacing.md,
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
  });
