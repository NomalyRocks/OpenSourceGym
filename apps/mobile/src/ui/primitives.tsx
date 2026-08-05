import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  withAlpha,
  type Theme,
} from "../theme";
import { CheckGlyph } from "../components/icons";
import { easing, useReducedMotion } from "./motion";

export type Tone = "neutral" | "accent" | "success" | "warning" | "error";

function toneColors(theme: Theme, tone: Tone) {
  switch (tone) {
    case "accent":
      return {
        foreground: theme.colors.accent,
        background: theme.colors.accentSurface,
      };
    case "success":
      return {
        foreground: theme.colors.success,
        background: theme.colors.successSurface,
      };
    case "warning":
      return {
        foreground: theme.colors.warning,
        background: theme.colors.warningSurface,
      };
    case "error":
      return {
        foreground: theme.colors.error,
        background: theme.colors.errorSurface,
      };
    default:
      return {
        foreground: theme.colors.textSecondary,
        background: theme.colors.surfaceRaised,
      };
  }
}

// ---------------------------------------------------------------- Button

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  busy = false,
  disabled = false,
  variant = "primary",
  size = "md",
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: (color: string) => ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const inactive = disabled || busy;

  const foreground =
    variant === "primary"
      ? theme.colors.onAccent
      : variant === "danger"
        ? theme.colors.error
        : variant === "ghost"
          ? theme.colors.accent
          : theme.colors.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      accessibilityLabel={title}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        size === "sm" && styles.buttonSm,
        variant === "secondary" && styles.buttonSecondary,
        variant === "ghost" && styles.buttonGhost,
        variant === "danger" && styles.buttonDanger,
        pressed && variant === "primary" && styles.buttonPrimaryPressed,
        pressed && variant !== "primary" && styles.buttonQuietPressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <>
          {icon?.(foreground)}
          <Text
            numberOfLines={1}
            style={[
              styles.buttonLabel,
              size === "sm" && styles.buttonLabelSm,
              { color: foreground },
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Icon-only header action with an optional counter dot. */
export function IconButton({
  label,
  onPress,
  icon,
  badgeCount,
}: {
  label: string;
  onPress: () => void;
  icon: (color: string) => ReactNode;
  badgeCount?: number;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const showBadge = (badgeCount ?? 0) > 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={showBadge ? `${label} (${badgeCount})` : label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && styles.iconButtonPressed,
      ]}
    >
      {icon(theme.colors.textPrimary)}
      {showBadge ? (
        <View style={styles.iconButtonBadge}>
          <Text style={styles.iconButtonBadgeText} numberOfLines={1}>
            {badgeCount! > 9 ? "9+" : badgeCount}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ----------------------------------------------------------------- Field

type FieldProps = TextInputProps & {
  label: string;
  error?: string | null;
  helperText?: string;
  inputRef?: Ref<TextInput>;
  trailing?: ReactNode;
};

export function Field({
  label,
  error,
  helperText,
  inputRef,
  trailing,
  style,
  onFocus,
  onBlur,
  ...inputProps
}: FieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const [focused, setFocused] = useState(false);
  const disabled = inputProps.editable === false;

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View
        style={[
          styles.inputBox,
          focused && styles.inputBoxFocused,
          error ? styles.inputBoxError : null,
          disabled && styles.inputBoxDisabled,
        ]}
      >
        <TextInput
          ref={inputRef}
          placeholderTextColor={theme.colors.textTertiary}
          selectionColor={theme.colors.accent}
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          accessibilityHint={error ?? helperText}
          {...inputProps}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[styles.input, disabled && styles.inputDisabled, style]}
        />
        {trailing}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : helperText ? (
        <Text style={styles.fieldHelper}>{helperText}</Text>
      ) : null}
    </View>
  );
}

function EyeIcon({
  visible,
  color,
  size = 19,
}: {
  visible: boolean;
  color: string;
  size?: number;
}) {
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.24,
          width: size,
          height: size * 0.54,
          borderRadius: size,
          borderWidth: 1.5,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: size * 0.42,
          width: size * 0.24,
          height: size * 0.24,
          borderRadius: size,
          backgroundColor: color,
        }}
      />
      {visible ? null : (
        <View
          style={{
            position: "absolute",
            top: size * 0.46,
            width: size * 1.16,
            height: 1.5,
            backgroundColor: color,
            transform: [{ rotate: "-42deg" }],
          }}
        />
      )}
    </View>
  );
}

export function PasswordField({
  label,
  error,
  helperText,
  inputRef,
  ...inputProps
}: Omit<FieldProps, "secureTextEntry" | "trailing">) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  return (
    <Field
      {...inputProps}
      inputRef={inputRef}
      label={label}
      error={error}
      helperText={helperText}
      secureTextEntry={!visible}
      trailing={
        <Pressable
          onPress={() => setVisible((current) => !current)}
          accessibilityRole="button"
          accessibilityLabel={visible ? t("Hide password") : t("Show password")}
          hitSlop={10}
          style={({ pressed }) => [
            styles.trailingButton,
            pressed && styles.pressedSoft,
          ]}
        >
          <EyeIcon visible={visible} color={theme.colors.textSecondary} />
        </Pressable>
      }
    />
  );
}

// -------------------------------------------------------------- Checkbox

export function Checkbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.checkboxRow,
        pressed && styles.pressedSoft,
      ]}
      onPress={onToggle}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? (
          <CheckGlyph size={15} color={theme.colors.onAccent} />
        ) : null}
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </Pressable>
  );
}

/** System switch with standard affordance and theme colors. */
export function Toggle({
  value,
  onValueChange,
  label,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={label}
      trackColor={{
        false: theme.colors.outlineStrong,
        true: theme.colors.accent,
      }}
      thumbColor={
        theme.name === "dark" ? theme.colors.textPrimary : theme.colors.surface
      }
      ios_backgroundColor={theme.colors.outlineStrong}
    />
  );
}

// ------------------------------------------------------------- Segmented

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: (color: string) => ReactNode;
}

/** Selection strip with a sliding indicator—for theme mode and language. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (next: T) => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const indicator = useRef(new Animated.Value(0)).current;
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
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

  const padding = 3;
  const cellWidth =
    trackWidth > 0 ? (trackWidth - padding * 2) / options.length : 0;

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={styles.segmented}
      onLayout={(event: LayoutChangeEvent) =>
        setTrackWidth(event.nativeEvent.layout.width)
      }
    >
      {cellWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentIndicator,
            {
              width: cellWidth,
              transform: [
                {
                  translateX: indicator.interpolate({
                    inputRange: options.map((_, index) => index),
                    outputRange: options.map((_, index) => index * cellWidth),
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        const color = selected
          ? theme.colors.textPrimary
          : theme.colors.textTertiary;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              pressed && !selected && styles.pressedSoft,
            ]}
          >
            {option.icon?.(color)}
            <Text
              numberOfLines={1}
              style={[styles.segmentLabel, { color }]}
              maxFontSizeMultiplier={1.4}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ----------------------------------------------------------------- Badge

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: Tone;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const palette = toneColors(theme, tone);

  return (
    <View style={[styles.badge, { backgroundColor: palette.background }]}>
      <Text
        numberOfLines={1}
        style={[styles.badgeLabel, { color: palette.foreground }]}
      >
        {label}
      </Text>
    </View>
  );
}

// --------------------------------------------------------- StatusMessage

export function StatusMessage({
  text,
  tone = "error",
  actionLabel,
  onAction,
  style,
}: {
  text: string | null | undefined;
  tone?: Tone;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  if (!text) return null;

  const palette = toneColors(theme, tone);

  return (
    <View
      accessibilityRole={tone === "error" ? "alert" : undefined}
      style={[
        styles.message,
        { backgroundColor: palette.background },
        tone !== "neutral" && {
          borderColor: withAlpha(palette.foreground, 0.24),
          borderWidth: StyleSheet.hairlineWidth,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.messageText,
          {
            color:
              tone === "neutral"
                ? theme.colors.textSecondary
                : palette.foreground,
          },
        ]}
      >
        {text}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          hitSlop={8}
          style={({ pressed }) => [
            styles.messageAction,
            pressed && styles.pressedSoft,
          ]}
        >
          <Text
            style={[
              styles.messageActionLabel,
              {
                color:
                  tone === "neutral" ? theme.colors.accent : palette.foreground,
              },
            ]}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ErrorMsg({ text }: { text: string | null }) {
  return <StatusMessage text={text} />;
}

export function InfoMsg({ text }: { text: string | null }) {
  return <StatusMessage text={text} tone="success" />;
}

// -------------------------------------------------------------- Skeleton

export function Skeleton({
  width = "100%",
  height,
  radius: skeletonRadius,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduced) {
      pulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 720,
          easing: easing.inOut,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.5,
          duration: 720,
          easing: easing.inOut,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: skeletonRadius ?? theme.radius.small,
          backgroundColor: theme.colors.skeleton,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

// ----------------------------------------------------------------- Meter

/**
 * Occupancy bar. The fill reveals with a left-anchored `translateX`—animating
 * width would recalculate layout on every frame.
 */
export function Meter({
  ratio,
  color,
  label,
  valueText,
}: {
  /** Between 0 and 1; draws an empty track when null. */
  ratio: number | null;
  color: string;
  label: string;
  valueText?: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const clamped = ratio == null ? 0 : Math.max(0, Math.min(1, ratio));

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    // Reveal the fill again when the value refreshes; otherwise the width jumps
    // instantly and the motion conveys no state.
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: theme.motion.slow,
      easing: easing.out,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [clamped, progress, reduced, theme.motion.slow]);

  const fillWidth = trackWidth * clamped;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: ratio == null ? undefined : Math.round(clamped * 100),
        text: valueText,
      }}
      style={styles.meterTrack}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
    >
      {fillWidth > 0 ? (
        <Animated.View
          style={[
            styles.meterFill,
            {
              width: fillWidth,
              backgroundColor: color,
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-fillWidth, 0],
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------ SettingRow

/** Single-row component for settings and profile lists. */
export function SettingRow({
  icon,
  title,
  subtitle,
  trailing,
  onPress,
  tone = "neutral",
  disabled,
}: {
  icon?: (color: string) => ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  tone?: "neutral" | "danger";
  disabled?: boolean;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(primitiveStyles);
  const foreground =
    tone === "danger" ? theme.colors.error : theme.colors.textPrimary;

  const body = (
    <>
      {icon ? (
        <View
          style={[
            styles.rowIcon,
            tone === "danger" && { backgroundColor: theme.colors.errorSurface },
          ]}
        >
          {icon(foreground)}
        </View>
      ) : null}
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: foreground }]}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{body}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
    >
      {body}
    </Pressable>
  );
}

const primitiveStyles = (theme: Theme) =>
  StyleSheet.create({
    pressedSoft: { opacity: 0.6 },
    disabled: { opacity: 0.45 },

    button: {
      minHeight: 54,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
    },
    buttonSm: { minHeight: 42, paddingHorizontal: theme.spacing.md },
    buttonSecondary: { backgroundColor: theme.colors.surfaceRaised },
    buttonGhost: { backgroundColor: "transparent" },
    buttonDanger: { backgroundColor: theme.colors.errorSurface },
    buttonPrimaryPressed: { backgroundColor: theme.colors.accentPressed },
    buttonQuietPressed: { opacity: 0.66 },
    buttonLabel: { ...theme.type.body, fontWeight: "700", flexShrink: 1 },
    buttonLabelSm: { ...theme.type.label, flexShrink: 1 },

    iconButton: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.control,
      alignItems: "center",
      justifyContent: "center",
    },
    iconButtonPressed: { backgroundColor: theme.colors.pressedOverlay },
    iconButtonBadge: {
      position: "absolute",
      top: 6,
      right: 5,
      minWidth: 17,
      height: 17,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: theme.colors.background,
    },
    iconButtonBadgeText: {
      fontSize: 10,
      lineHeight: 13,
      fontWeight: "700",
      color: theme.colors.onAccent,
      ...tabularNumbers,
    },

    field: { gap: 7 },
    fieldLabel: { ...theme.type.label, color: theme.colors.textSecondary },
    inputBox: {
      minHeight: 54,
      borderRadius: theme.radius.input,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surfaceInput,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    inputBoxFocused: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface,
    },
    inputBoxError: { borderColor: theme.colors.error },
    inputBoxDisabled: {
      backgroundColor: theme.colors.surfaceRaised,
      borderColor: "transparent",
    },
    input: {
      ...theme.type.body,
      flex: 1,
      color: theme.colors.textPrimary,
      paddingVertical: 12,
    },
    inputDisabled: { color: theme.colors.textSecondary },
    trailingButton: {
      width: 46,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    fieldHelper: { ...theme.type.supporting, color: theme.colors.textTertiary },
    fieldError: { ...theme.type.supporting, color: theme.colors.error },

    checkboxRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineStrong,
      backgroundColor: theme.colors.surfaceInput,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    checkboxChecked: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    checkboxLabel: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      flex: 1,
    },

    segmented: {
      flexDirection: "row",
      alignItems: "stretch",
      padding: 3,
      borderRadius: theme.radius.input,
      backgroundColor: theme.colors.surfaceRaised,
    },
    segmentIndicator: {
      position: "absolute",
      top: 3,
      left: 3,
      bottom: 3,
      borderRadius: theme.radius.small,
      backgroundColor: theme.colors.surface,
      borderWidth: theme.name === "dark" ? StyleSheet.hairlineWidth : 0,
      borderColor: theme.colors.outlineStrong,
      ...theme.shadows.plate,
    },
    segment: {
      flex: 1,
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 6,
    },
    segmentLabel: { ...theme.type.label, flexShrink: 1 },

    badge: {
      borderRadius: theme.radius.pill,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      alignSelf: "flex-start",
      maxWidth: 180,
    },
    badgeLabel: { ...theme.type.label, fontSize: 12, lineHeight: 16 },

    message: {
      borderRadius: theme.radius.input,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: theme.spacing.xxs,
    },
    messageText: { ...theme.type.supporting },
    messageAction: { minHeight: 36, justifyContent: "center" },
    messageActionLabel: { ...theme.type.label },

    meterTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.surfaceRaised,
      overflow: "hidden",
    },
    meterFill: { height: "100%", borderRadius: 4 },

    row: {
      minHeight: 58,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
    },
    rowPressed: { backgroundColor: theme.colors.pressedOverlay },
    rowIcon: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.small,
      backgroundColor: theme.colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    rowCopy: { flex: 1, gap: 1 },
    rowTitle: { ...theme.type.title, fontSize: 16, lineHeight: 21 },
    rowSubtitle: {
      ...theme.type.supporting,
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.textSecondary,
    },
  });
