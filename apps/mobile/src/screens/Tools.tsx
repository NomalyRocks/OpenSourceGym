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
        title={t("Araçlar")}
        subtitle={t(
          "Antrenman hedeflerini planlamana yardımcı olan hesaplayıcılar.",
        )}
      />

      {/* Tek satırlık, tam genişlik kart: bir 2 sütunlu ızgara tek öğede
          yarı boş kalır. Yeni araçlar eklendiğinde bu satır altına aynen
          çoğaltılır — ızgara matematiği değil, dikey bir liste büyür. */}
      <View style={styles.list}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Günlük kalori ihtiyacı")}
          accessibilityHint={t(
            "Kalori ve makro hesaplama akışını tam ekranda açar.",
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
                    {t("Günlük kalori ihtiyacı")}
                  </Text>
                  <Text style={styles.cardBody}>
                    {t("Hedef kalorilerini ve günlük makrolarını tahmin et.")}
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
