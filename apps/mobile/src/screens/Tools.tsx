import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CalculatorGlyph, ChevronRightGlyph } from "../components/icons";
import { useTheme, useThemedStyles, type Theme } from "../theme";
import { Plate, ScreenHeader, ScrollScreen } from "../ui";
import { CalorieCalculator } from "./CalorieCalculator";

export function Tools({
  onFullscreenChange,
}: {
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(toolsStyles);
  const [calculatorOpen, setCalculatorOpen] = useState(false);

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
        title={t("Tools")}
        subtitle={t("Calculators that help you plan your training goals.")}
      />

      {/* Single-row, full-width card: a two-column grid would remain half empty
          with one item. New tools duplicate this row below, growing a vertical
          list rather than introducing grid math. */}
      <View style={styles.list}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Daily calorie needs")}
          accessibilityHint={t(
            "Opens the calorie and macro calculator in full screen.",
          )}
          onPress={openCalculator}
        >
          {({ pressed }) => (
            <Plate style={pressed && styles.cardPressed}>
              <View style={styles.cardRow}>
                <View style={styles.iconWell}>
                  <CalculatorGlyph size={26} color={theme.colors.accent} />
                </View>
                <View style={styles.cardCopy}>
                  <Text style={styles.cardTitle}>
                    {t("Daily calorie needs")}
                  </Text>
                  <Text style={styles.cardBody}>
                    {t("Estimate your target calories and daily macros.")}
                  </Text>
                </View>
                <ChevronRightGlyph
                  size={18}
                  color={theme.colors.textTertiary}
                />
              </View>
            </Plate>
          )}
        </Pressable>
      </View>
    </ScrollScreen>
  );
}

const toolsStyles = (theme: Theme) =>
  StyleSheet.create({
    list: { gap: theme.spacing.sm },
    cardPressed: { backgroundColor: theme.colors.surfaceRaised },
    cardRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
    },
    iconWell: {
      width: 52,
      height: 52,
      borderRadius: theme.radius.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.accentSurface,
    },
    cardCopy: { flex: 1, gap: 2 },
    cardTitle: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
    },
    cardBody: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
  });
