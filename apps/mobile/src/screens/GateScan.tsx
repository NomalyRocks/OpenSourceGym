import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  Linking,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import type { GateScanResponse } from "@opengym/shared";
import { ApiError, api } from "../lib/api";
import { AlertGlyph, CheckGlyph, QrGlyph } from "../components/icons";
import { useTheme, useThemedStyles, type Theme } from "../theme";
import {
  Button,
  Screen,
  ScreenHeader,
  StatusMessage,
  easing,
  useReducedMotion,
} from "../ui";
import { errorMessage } from "../i18n/errors";

type ScanState =
  | { kind: "scanning" }
  | { kind: "validating" }
  | { kind: "success"; data: GateScanResponse }
  | { kind: "denied"; message: string; code?: string };

const GATE_QR_PREFIX = "OGGATE1.";
// Must exceed the server's duplicate-scan lock (3 seconds); if the camera reopens
// while the lock is active, a successful entry appears rejected with a 429.
const RESCAN_DELAY_MS = 3500;
const LOCATION_TIMEOUT_MS = 5000;

/** Scan line moving through the finder frame—conveys the "reading now" state. */
function ScanLine({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const travel = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (reduced || height === 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 1,
          duration: 1600,
          easing: easing.inOut,
          useNativeDriver: true,
        }),
        Animated.timing(travel, {
          toValue: 0,
          duration: 1600,
          easing: easing.inOut,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [height, reduced, travel]);

  if (reduced) return null;

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      <Animated.View
        style={{
          height: 2,
          backgroundColor: color,
          opacity: 0.9,
          transform: [
            {
              translateY: travel.interpolate({
                inputRange: [0, 1],
                outputRange: [0, Math.max(0, height - 2)],
              }),
            },
          ],
        }}
      />
    </View>
  );
}

export function GateScan() {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(scanStyles);
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<ScanState>({ kind: "scanning" });
  const busyRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetToScanning = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
    busyRef.current = false;
    setState({ kind: "scanning" });
  }, []);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const notifyResult = useCallback((success: boolean) => {
    requestAnimationFrame(() => {
      void Haptics.notificationAsync(
        success
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Error,
      ).catch(() => undefined);
    });
  }, []);

  const onBarcodeScanned = useCallback(
    async (result: BarcodeScanningResult) => {
      if (busyRef.current || !result.data.startsWith(GATE_QR_PREFIX)) return;

      busyRef.current = true;
      setState({ kind: "validating" });

      let lat: number | undefined;
      let lng: number | undefined;
      let mocked: boolean | undefined;
      try {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        if (granted) {
          // GPS sometimes stalls—instead of showing "verifying" indefinitely,
          // continue without location after timeout and let the API decide.
          const position = await Promise.race([
            Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            }),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS),
            ),
          ]);
          if (position) {
            lat = position.coords.latitude;
            lng = position.coords.longitude;
            mocked = position.mocked === true;
          }
        }
      } catch {
        // The API decides whether entry without location is allowed.
      }

      try {
        const body =
          lat !== undefined && lng !== undefined
            ? { qr: result.data, lat, lng, mocked }
            : { qr: result.data };
        const response = await api<GateScanResponse>("/api/me/gate-scan", {
          method: "POST",
          body,
        });
        setState({ kind: "success", data: response });
        notifyResult(true);
        resetTimerRef.current = setTimeout(resetToScanning, RESCAN_DELAY_MS);
      } catch (error) {
        if (error instanceof ApiError) {
          setState({
            kind: "denied",
            message: errorMessage(
              error,
              t,
              "An unexpected error occurred. Please try again.",
            ),
            code: error.code,
          });
        } else {
          setState({
            kind: "denied",
            message: t("Connection error. Please try again."),
          });
        }
        notifyResult(false);
      }
    },
    [notifyResult, resetToScanning, t],
  );

  if (!permission) {
    return (
      <Screen style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </Screen>
    );
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false;
    return (
      <Screen>
        <ScreenHeader title={t("Scan QR")} />
        <View style={styles.permission}>
          <View style={styles.permissionIcon}>
            <QrGlyph size={28} color={theme.colors.accent} />
          </View>
          <Text style={styles.resultTitle}>
            {t("Camera access is required")}
          </Text>
          <Text style={styles.resultDetail}>
            {t("Camera access is required to scan the turnstile QR code.")}
          </Text>
          <View style={styles.permissionAction}>
            <Button
              title={canAskAgain ? t("Allow") : t("Open settings")}
              onPress={() =>
                canAskAgain
                  ? void requestPermission()
                  : void Linking.openSettings()
              }
            />
          </View>
        </View>
      </Screen>
    );
  }

  const scanning = state.kind === "scanning" || state.kind === "validating";

  return (
    <Screen>
      <ScreenHeader
        title={t("Scan QR")}
        subtitle={t("Point the camera at the OpenGym code on the turnstile.")}
      />

      {scanning ? (
        <View style={styles.scanBody}>
          <View style={styles.cameraFrame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={
                state.kind === "scanning"
                  ? (result) => void onBarcodeScanned(result)
                  : undefined
              }
            />
            <View style={styles.cameraShade} pointerEvents="none" />
            <View style={styles.finder} pointerEvents="none">
              <View style={[styles.corner, styles.cornerTopLeft]} />
              <View style={[styles.corner, styles.cornerTopRight]} />
              <View style={[styles.corner, styles.cornerBottomLeft]} />
              <View style={[styles.corner, styles.cornerBottomRight]} />
              {state.kind === "scanning" ? (
                <ScanLine color={theme.colors.accent} />
              ) : null}
            </View>
            {state.kind === "validating" ? (
              <View style={styles.validating}>
                <ActivityIndicator color={theme.colors.onAccent} />
                <Text style={styles.validatingText}>
                  {t("Validating entry…")}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.hint}>
            {state.kind === "validating"
              ? t("We are checking the code. Please wait a moment.")
              : t("Validation starts automatically when a code is detected.")}
          </Text>
        </View>
      ) : state.kind === "success" ? (
        <View style={styles.resultPanel}>
          <View style={[styles.resultIcon, styles.resultIconSuccess]}>
            <CheckGlyph size={34} color={theme.colors.success} />
          </View>
          <Text style={styles.resultTitle}>{t("Turnstile opened")}</Text>
          <Text style={styles.resultDetail}>
            {t("A {{direction}} record was created for {{device}}.", {
              device: state.data.deviceName,
              direction:
                state.data.direction === "out" ? t("exit") : t("entry"),
            })}
          </Text>
          <StatusMessage
            tone="success"
            text={t("The camera will reopen shortly for a new scan.")}
          />
        </View>
      ) : (
        <View style={styles.resultPanel}>
          <View style={[styles.resultIcon, styles.resultIconError]}>
            <AlertGlyph size={32} color={theme.colors.error} />
          </View>
          <Text style={styles.resultTitle}>
            {t("Entry could not be completed")}
          </Text>
          <Text style={styles.resultDetail}>{state.message}</Text>
          <RecoveryHint code={state.code} />
          <View style={styles.resultAction}>
            <Button title={t("Scan again")} onPress={resetToScanning} />
          </View>
        </View>
      )}
    </Screen>
  );
}

function RecoveryHint({ code }: { code?: string }) {
  const { t } = useTranslation();
  const text =
    code === "LOCATION_REQUIRED"
      ? t("Enable location permission and try again.")
      : code === "MOCK_LOCATION"
        ? t("Disable the mock location app and try again.")
        : code === "SHARING_BLOCKED"
          ? t("Contact gym reception about the account-sharing block.")
          : code === "DEVICE_OFFLINE"
            ? t("The turnstile is offline. Ask gym reception for help.")
            : t("Contact gym reception if the problem continues.");

  return <StatusMessage tone="neutral" text={text} />;
}

const scanStyles = (theme: Theme) =>
  StyleSheet.create({
    center: { alignItems: "center", justifyContent: "center" },

    permission: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.md,
    },
    permissionIcon: {
      width: 64,
      height: 64,
      borderRadius: theme.radius.card,
      backgroundColor: theme.colors.accentSurface,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.lg,
    },
    permissionAction: { alignSelf: "stretch", marginTop: theme.spacing.md },

    scanBody: { flex: 1, justifyContent: "center" },
    cameraFrame: {
      width: "100%",
      maxWidth: 520,
      aspectRatio: 1,
      alignSelf: "center",
      overflow: "hidden",
      borderRadius: theme.radius.card,
      backgroundColor: theme.colors.alwaysDarkSurface,
    },
    cameraShade: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.18)",
    },
    finder: {
      position: "absolute",
      width: "64%",
      aspectRatio: 1,
      alignSelf: "center",
      top: "18%",
      overflow: "hidden",
    },
    corner: {
      position: "absolute",
      width: 34,
      height: 34,
      borderColor: theme.colors.accent,
      zIndex: 2,
    },
    cornerTopLeft: {
      top: 0,
      left: 0,
      borderTopWidth: 3,
      borderLeftWidth: 3,
      borderTopLeftRadius: theme.radius.tiny,
    },
    cornerTopRight: {
      top: 0,
      right: 0,
      borderTopWidth: 3,
      borderRightWidth: 3,
      borderTopRightRadius: theme.radius.tiny,
    },
    cornerBottomLeft: {
      bottom: 0,
      left: 0,
      borderBottomWidth: 3,
      borderLeftWidth: 3,
      borderBottomLeftRadius: theme.radius.tiny,
    },
    cornerBottomRight: {
      bottom: 0,
      right: 0,
      borderBottomWidth: 3,
      borderRightWidth: 3,
      borderBottomRightRadius: theme.radius.tiny,
    },
    validating: {
      position: "absolute",
      left: theme.spacing.lg,
      right: theme.spacing.lg,
      bottom: theme.spacing.lg,
      minHeight: 52,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.accent,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
    },
    validatingText: { ...theme.type.label, color: theme.colors.onAccent },
    hint: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.lg,
    },

    resultPanel: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.md,
    },
    resultIcon: {
      width: 76,
      height: 76,
      borderRadius: 38,
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
    },
    resultIconSuccess: { backgroundColor: theme.colors.successSurface },
    resultIconError: { backgroundColor: theme.colors.errorSurface },
    resultTitle: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
      textAlign: "center",
      marginTop: theme.spacing.lg,
    },
    resultDetail: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.lg,
    },
    resultAction: { marginTop: theme.spacing.sm },
  });
