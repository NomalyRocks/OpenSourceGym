import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useTranslation } from "react-i18next";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { authClient } from "./src/lib/auth";
import {
  checkDeviceIntegrity,
  type DeviceIntegrityResult,
} from "./src/lib/deviceIntegrity";
import {
  useNotificationCenter,
  type NotificationCenter,
} from "./src/lib/notifications";
import {
  ThemeProvider,
  useTheme,
  useThemedStyles,
  useThemeMode,
  type Theme,
} from "./src/theme";
import {
  BottomInsetProvider,
  Button,
  LogoMark,
  Screen,
  StatusMessage,
  easing,
  useReducedMotion,
} from "./src/ui";
import { Splash } from "./src/screens/Splash";
import { Login } from "./src/screens/Login";
import { Register } from "./src/screens/Register";
import { VerifyOtp } from "./src/screens/VerifyOtp";
import { ForgotPassword } from "./src/screens/ForgotPassword";
import { ResetPassword } from "./src/screens/ResetPassword";
import { Home } from "./src/screens/Home";
import { Calendar } from "./src/screens/Calendar";
import { GateScan } from "./src/screens/GateScan";
import { Profile } from "./src/screens/Profile";
import { Notifications } from "./src/screens/Notifications";
import { Settings } from "./src/screens/Settings";
import {
  BottomTabBar,
  useTabBarSpace,
  type AppTab,
} from "./src/components/BottomTabBar";
import { LanguageSwitcher } from "./src/i18n/LanguageSwitcher";
import { initializeLocalization, syncDeviceLanguage } from "./src/i18n";

type ScreenState =
  | { name: "login" }
  | { name: "register" }
  | { name: "verify"; email: string; password: string }
  | { name: "forgot" }
  | { name: "reset"; email: string };

/** Sekmelerin üstüne itilen tam ekran katman (Bildirimler, Ayarlar). */
type Overlay = "notifications" | "settings" | null;

function PushedScreen({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduced ? 120 : theme.motion.standard,
      easing: visible ? easing.out : easing.in,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [progress, reduced, theme.motion.standard, visible]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: theme.colors.background,
          // Android'de `elevation` sıralamada `zIndex`i ezer; yüzen sekme
          // çubuğu elevation 10 taşıdığı için burada daha yükseği gerekiyor.
          zIndex: 30,
          elevation: 24,
          opacity: progress,
          transform: reduced
            ? []
            : [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [width * 0.24, 0],
                  }),
                },
              ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function DeviceBlocked({ onHome }: { onHome: () => void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(appStyles);

  return (
    <Screen style={styles.blockedScreen}>
      <LogoMark size={52} />
      <Text accessibilityRole="header" style={styles.blockedTitle}>
        {t("Bu cihazda QR kullanılamıyor")}
      </Text>
      <Text style={styles.blockedBody}>
        {t(
          "Cihazınızda güvenlik riski tespit edildi (root/jailbreak veya hata ayıklama). Güvenlik nedeniyle QR ile giriş bu cihazda kullanılamaz.",
        )}
      </Text>
      <View style={styles.blockedNote}>
        <StatusMessage
          tone="warning"
          text={t("Yardım için salon resepsiyonuna başvurun.")}
        />
      </View>
      <Button title={t("Ana sayfaya dön")} onPress={onHome} />
    </Screen>
  );
}

function SignedInApp({
  userName,
  integrity,
  center,
}: {
  userName: string;
  integrity: DeviceIntegrityResult | null;
  center: NotificationCenter;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(appStyles);
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [visited, setVisited] = useState<Record<AppTab, boolean>>({
    home: true,
    calendar: false,
    scan: false,
    profile: false,
  });
  const reducedMotion = useReducedMotion();
  const tabBarSpace = useTabBarSpace();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    setVisited((current) =>
      current[activeTab] ? current : { ...current, [activeTab]: true },
    );
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.74);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: theme.motion.standard,
      easing: easing.out,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [activeTab, opacity, reducedMotion, theme.motion.standard]);

  // Android geri tuşu itilen ekranı kapatır; sekmelerdeyken sistem davranışı kalır.
  useEffect(() => {
    if (!overlay) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setOverlay(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, [overlay]);

  return (
    <View style={styles.root}>
      <BottomInsetProvider value={tabBarSpace}>
        <Animated.View style={[styles.flex, { opacity }]}>
          <View style={activeTab === "home" ? styles.flex : styles.hidden}>
            <Home
              userName={userName}
              onOpenQr={() => setActiveTab("scan")}
              onOpenNotifications={() => setOverlay("notifications")}
              onOpenProfile={() => setActiveTab("profile")}
              unreadCount={center.unreadCount}
            />
          </View>

          {visited.calendar ? (
            <View
              style={activeTab === "calendar" ? styles.flex : styles.hidden}
            >
              <Calendar />
            </View>
          ) : null}

          {/* Kamera yalnızca sekme etkinken monte edilir. */}
          {activeTab === "scan" ? (
            integrity === null ? (
              <View style={styles.loading}>
                <ActivityIndicator color={theme.colors.accent} size="large" />
              </View>
            ) : integrity.compromised ? (
              <DeviceBlocked onHome={() => setActiveTab("home")} />
            ) : (
              <GateScan />
            )
          ) : null}

          {visited.profile ? (
            <View style={activeTab === "profile" ? styles.flex : styles.hidden}>
              <Profile
                fallbackName={userName}
                onOpenSettings={() => setOverlay("settings")}
              />
            </View>
          ) : null}
        </Animated.View>

        <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} />
      </BottomInsetProvider>

      {/* İtilen ekranlar sekme çubuğunu kapatır; alt pay onlara uygulanmaz. */}
      <BottomInsetProvider value={0}>
        <PushedScreen visible={overlay === "notifications"}>
          <Notifications center={center} onBack={() => setOverlay(null)} />
        </PushedScreen>
        <PushedScreen visible={overlay === "settings"}>
          <Settings center={center} onBack={() => setOverlay(null)} />
        </PushedScreen>
      </BottomInsetProvider>
    </View>
  );
}

function AppContent() {
  const theme = useTheme();
  const styles = useThemedStyles(appStyles);
  const { ready: themeReady } = useThemeMode();
  const { data: session, isPending } = authClient.useSession();
  const [localizationReady, setLocalizationReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [screen, setScreen] = useState<ScreenState>({ name: "login" });
  const [integrity, setIntegrity] = useState<DeviceIntegrityResult | null>(
    null,
  );
  const hadSession = useRef(false);
  const center = useNotificationCenter(Boolean(session));

  useEffect(() => {
    void initializeLocalization().then(() => setLocalizationReady(true));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncDeviceLanguage();
    });
    return () => subscription.remove();
  }, []);

  const resetToLogin = useCallback(() => {
    setScreen({ name: "login" });
  }, []);

  useEffect(() => {
    if (session) {
      hadSession.current = true;
      return;
    }
    if (hadSession.current) {
      hadSession.current = false;
      resetToLogin();
    }
  }, [resetToLogin, session]);

  useEffect(() => {
    void checkDeviceIntegrity().then(setIntegrity);
  }, []);

  const bootReady = localizationReady && themeReady && !isPending;

  let body: ReactNode = null;
  if (!bootReady) {
    body = <View style={styles.loading} />;
  } else if (session) {
    body = (
      <SignedInApp
        userName={session.user.name}
        integrity={integrity}
        center={center}
      />
    );
  } else if (screen.name === "register") {
    body = (
      <Register
        onLogin={resetToLogin}
        onRegistered={(email, password) =>
          setScreen({ name: "verify", email, password })
        }
      />
    );
  } else if (screen.name === "verify") {
    body = (
      <VerifyOtp
        email={screen.email}
        password={screen.password}
        onBack={resetToLogin}
        onVerified={resetToLogin}
      />
    );
  } else if (screen.name === "forgot") {
    body = (
      <ForgotPassword
        onBack={resetToLogin}
        onSent={(email) => setScreen({ name: "reset", email })}
      />
    );
  } else if (screen.name === "reset") {
    body = (
      <ResetPassword
        email={screen.email}
        onBack={resetToLogin}
        onDone={resetToLogin}
      />
    );
  } else {
    body = (
      <Login
        onRegister={() => setScreen({ name: "register" })}
        onNeedsVerification={(email, password) =>
          setScreen({ name: "verify", email, password })
        }
        onForgot={() => setScreen({ name: "forgot" })}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style={theme.statusBarStyle} />
      {body}
      {splashDone && bootReady && !session ? (
        <LanguageSwitcher floating />
      ) : null}
      {splashDone ? null : (
        <Splash ready={bootReady} onFinish={() => setSplashDone(true)} />
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const appStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.background },
    flex: { flex: 1 },
    hidden: { display: "none" },
    loading: {
      flex: 1,
      backgroundColor: theme.colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    blockedScreen: { justifyContent: "center" },
    blockedTitle: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
      marginTop: theme.spacing.xl,
    },
    blockedBody: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },
    blockedNote: {
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.lg,
    },
  });
