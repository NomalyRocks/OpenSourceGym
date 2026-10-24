import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import { easing, useReducedMotion } from "./motion";
import { Button, StatusMessage } from "./primitives";

/** Label/value rows for a sheet body. */
export function SheetFacts({
  rows,
}: {
  rows: ReadonlyArray<{ label: string; value: string }>;
}) {
  const styles = useThemedStyles(sheetStyles);
  return (
    <View style={styles.facts}>
      {rows.map((row) => (
        <View key={row.label} style={styles.factRow}>
          <Text style={styles.factLabel}>{row.label}</Text>
          <Text style={styles.factValue}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Bottom confirmation sheet: scrim fades in, the sheet slides up. Scrim tap and
 * Android back cancel unless `busy`; a failed confirm keeps the sheet open and
 * shows `error` inline.
 */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  confirmTone = "primary",
  cancelLabel,
  notice = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  confirmTone?: "primary" | "danger";
  /** Unused in notice mode. */
  cancelLabel?: string;
  /** Notice: a single button; scrim and back press act as confirm. */
  notice?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(sheetStyles);
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const titleRef = useRef<Text>(null);
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduced ? 150 : visible ? theme.motion.standard : 200,
      easing: visible ? easing.out : easing.in,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [progress, reduced, theme.motion.standard, visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 300);
    return () => clearTimeout(timer);
  }, [visible]);

  // The sheet stays on screen while it fades out; taps then must not re-fire.
  const confirm = () => {
    if (visible) onConfirm();
  };

  const cancel = () => {
    if (busy || !visible) return;
    if (notice) onConfirm();
    else onCancel?.();
  };

  return (
    <Modal
      transparent
      visible={mounted}
      statusBarTranslucent
      navigationBarTranslucent
      animationType="none"
      onRequestClose={cancel}
    >
      <View
        style={styles.root}
        accessibilityViewIsModal
        pointerEvents={visible ? "auto" : "none"}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.scrim, opacity: progress },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel ?? confirmLabel}
            onPress={cancel}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.spacing.md) },
            reduced
              ? { opacity: progress }
              : {
                  transform: [
                    {
                      translateY: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [height * 0.5, 0],
                      }),
                    },
                  ],
                },
          ]}
        >
          <View style={styles.handle} />
          <Text ref={titleRef} accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {body ? <View style={styles.body}>{body}</View> : null}
          <StatusMessage text={error} style={styles.error} />
          <View style={styles.actions}>
            <Button
              title={confirmLabel}
              variant={confirmTone}
              busy={busy}
              onPress={confirm}
            />
            {notice ? null : (
              <Button
                title={cancelLabel ?? ""}
                variant="ghost"
                disabled={busy}
                onPress={cancel}
              />
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const sheetStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: "flex-end" },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.sm,
      ...theme.shadows.raised,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.outlineStrong,
      marginBottom: theme.spacing.md,
    },
    title: { ...theme.type.sectionTitle, color: theme.colors.textPrimary },
    body: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },
    error: { marginTop: theme.spacing.md },
    actions: { marginTop: theme.spacing.lg, gap: theme.spacing.xs },
    facts: {
      marginTop: theme.spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outline,
    },
    factRow: {
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.outline,
    },
    factLabel: { ...theme.type.supporting, color: theme.colors.textSecondary },
    factValue: {
      ...theme.type.supporting,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
    },
  });
