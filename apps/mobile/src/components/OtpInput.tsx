import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";

const CELL_COUNT = 6;

/**
 * Six cells are controlled by a single invisible numeric TextInput. Tapping a
 * cell focuses the input; the cell containing the cursor receives the active
 * border.
 */
export function OtpInput({
  value,
  onChangeText,
  autoFocus,
  error,
}: {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(otpStyles);
  const inputRef = useRef<TextInput>(null);
  const activeIndex = Math.min(value.length, CELL_COUNT - 1);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{t("Verification code")}</Text>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.row}
        onPress={() => inputRef.current?.focus()}
      >
        {Array.from({ length: CELL_COUNT }).map((_, index) => {
          const digit = value[index] ?? "";
          const active = index === activeIndex;
          const filled = digit !== "";
          return (
            <View
              key={index}
              style={[
                styles.cell,
                filled && styles.cellFilled,
                active && styles.cellActive,
                error ? styles.cellError : null,
              ]}
            >
              <Text style={styles.digit}>{digit}</Text>
            </View>
          );
        })}
      </Pressable>
      <TextInput
        accessibilityLabel={t("Verification code")}
        accessibilityHint={error ?? undefined}
        ref={inputRef}
        value={value}
        onChangeText={(text) =>
          onChangeText(text.replace(/[^0-9]/g, "").slice(0, CELL_COUNT))
        }
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CELL_COUNT}
        autoFocus={autoFocus}
        caretHidden
        selectionColor={theme.colors.accent}
        style={styles.hiddenInput}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const otpStyles = (theme: Theme) =>
  StyleSheet.create({
    field: { width: "100%", gap: 7 },
    label: { ...theme.type.label, color: theme.colors.textSecondary },
    row: { flexDirection: "row", gap: 8, width: "100%" },
    cell: {
      flex: 1,
      maxWidth: 56,
      height: 58,
      borderRadius: theme.radius.input,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surfaceInput,
      alignItems: "center",
      justifyContent: "center",
    },
    cellFilled: { borderColor: theme.colors.outlineStrong },
    cellActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface,
    },
    cellError: { borderColor: theme.colors.error },
    digit: {
      fontSize: 21,
      lineHeight: 26,
      fontWeight: "700",
      color: theme.colors.textPrimary,
      ...tabularNumbers,
    },
    hiddenInput: {
      position: "absolute",
      top: 25,
      left: 0,
      right: 0,
      height: 58,
      opacity: 0,
    },
    error: { ...theme.type.supporting, color: theme.colors.error },
  });
