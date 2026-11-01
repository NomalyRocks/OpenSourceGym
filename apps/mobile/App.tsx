import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useTranslation } from "react-i18next";
import type { MemberBan, MyProfile } from "@opengym/shared";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { api } from "./src/lib/api";
import { authClient } from "./src/lib/auth";
import { TabSwipeLockContext } from "./src/lib/tabSwipeLock";
import { clearCalorieCalculatorState } from "./src/lib/calorieCalculatorStorage";
import {
  checkDeviceIntegrity,
  type DeviceIntegrityResult,
} from "./src/lib/deviceIntegrity";
import {
  useNotificationCenter,
  type NotificationCenter,
} from "./src/lib/notifications";
import {
  BrandThemeScope,
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
  authBandHeight,
  easing,
  useReducedMotion,
} from "./src/ui";
import { Splash } from "./src/screens/Splash";
import { Login } from "./src/screens/Login";
import { Register } from "./src/screens/Register";
import { VerifyOtp } from "./src/screens/VerifyOtp";
import { ForgotPassword } from "./src/screens/ForgotPassword";
import { ResetPassword } from "./src/screens/ResetPassword";
import { VerifyResetCode } from "./src/screens/VerifyResetCode";
import { Home } from "./src/screens/Home";
import { Gyms } from "./src/screens/Gyms";
import { GateScan } from "./src/screens/GateScan";
import { Profile } from "./src/screens/Profile";
import { Notifications } from "./src/screens/Notifications";
import { Settings } from "./src/screens/Settings";
import { Tools } from "./src/screens/Tools";
import {
  BottomTabBar,
  TAB_ORDER,
  useTabBarSpace,
  type AppTab,
} from "./src/components/BottomTabBar";
import { Banned } from "./src/screens/Banned";
import { LanguageSwitcher } from "./src/i18n/LanguageSwitcher";
import { initializeLocalization, syncDeviceLanguage } from "./src/i18n";

type ScreenState =
  | { name: "login" }
  | { name: "register" }
  | { name: "verify"; email: string; password: string }
  | { name: "forgot" }
  | { name: "resetCode"; email: string }
  | { name: "reset"; email: string; otp: string };

/** Full-screen layer pushed above the tabs (Notifications, Settings). */
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
          // On Android, `elevation` overrides `zIndex` ordering; because the
          // floating tab bar has elevation 10, this needs a higher value.
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
        {t("QR is unavailable on this device")}
      </Text>
      <Text style={styles.blockedBody}>
        {t(
          "A security risk was detected on your device (root/jailbreak or debugging). QR entry is unavailable on this device for security reasons.",
        )}
      </Text>
      <View style={styles.blockedNote}>
        <StatusMessage
          tone="warning"
          text={t("Contact gym reception for assistance.")}
        />
      </View>
      <Button title={t("Return to Home")} onPress={onHome} />
    </Screen>
  );
}

/**
 * Tracks the member's ban. `loaded` flips once the first profile request has
 * settled (success or failure), so a banned member never sees the tabs flash
 * before the ban screen. A failed refetch keeps the last known state: a flaky
 * network must neither ban nor unban anyone on screen.
 */
function useBan(): {
  ban: MemberBan | null;
  loaded: boolean;
  refresh: () => void;
} {
  const [ban, setBan] = useState<MemberBan | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    api<MyProfile>("/api/me/profile")
      .then((profile) => setBan(profile.ban ?? null))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    // An unban takes effect when the app returns to the foreground.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  return { ban, loaded, refresh };
}

function SignedInGate({
  userName,
  integrity,
  center,
}: {
  userName: string;
  integrity: DeviceIntegrityResult | null;
  center: NotificationCenter;
}) {
  const styles = useThemedStyles(appStyles);
  const { ban, loaded, refresh } = useBan();

  if (!loaded) return <View style={styles.loading} />;
  // The ban screen replaces the whole shell; only sign-out is offered.
  if (ban) return <Banned ban={ban} />;
  return (
    <SignedInApp
      userName={userName}
      integrity={integrity}
      center={center}
      onBanned={refresh}
    />
  );
}

function SignedInApp({
  userName,
  integrity,
  center,
  onBanned,
}: {
  userName: string;
  integrity: DeviceIntegrityResult | null;
  center: NotificationCenter;
  onBanned: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(appStyles);
  const { width: pageWidth } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toolsFullscreen, setToolsFullscreen] = useState(false);
  // Number of nested horizontal scrollers currently held by a finger.
  const [swipeLocks, setSwipeLocks] = useState(0);
  const swipeLock = useMemo(
    () => ({
      lock: () => setSwipeLocks((n) => n + 1),
      unlock: () => setSwipeLocks((n) => Math.max(0, n - 1)),
    }),
    [],
  );
  const [visited, setVisited] = useState<Record<AppTab, boolean>>({
    home: true,
    gyms: false,
    scan: false,
    tools: false,
    profile: false,
  });
  const reducedMotion = useReducedMotion();
  const tabBarSpace = useTabBarSpace();
  const scrollX = useRef(new Animated.Value(0)).current;
  const pager = useRef<ScrollView>(null);

  useEffect(() => {
    setVisited((current) =>
      current[activeTab] ? current : { ...current, [activeTab]: true },
    );
  }, [activeTab]);

  // Rotation or a window resize changes the page width: stay on the active tab.
  useEffect(() => {
    pager.current?.scrollTo({
      x: TAB_ORDER.indexOf(activeTab) * pageWidth,
      animated: false,
    });
    // Only the width matters; tab changes scroll through selectTab/swipes.
  }, [pageWidth]);

  function selectTab(tab: AppTab) {
    setActiveTab(tab);
    pager.current?.scrollTo({
      x: TAB_ORDER.indexOf(tab) * pageWidth,
      animated: !reducedMotion,
    });
  }

  // The Android back button closes the pushed screen; system behavior remains on tabs.
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

  const page = (tab: AppTab, content: ReactNode) => (
    <View key={tab} style={[styles.page, { width: pageWidth }]}>
      {content}
    </View>
  );

  return (
    <View style={styles.root}>
      <BottomInsetProvider value={toolsFullscreen ? 0 : tabBarSpace}>
        <TabSwipeLockContext.Provider value={swipeLock}>
          <Animated.ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            bounces={false}
            overScrollMode="never"
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!toolsFullscreen && !overlay && swipeLocks === 0}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => {
              // Mount the neighbours before they slide in, not after the swipe.
              const index = TAB_ORDER.indexOf(activeTab);
              const next = [TAB_ORDER[index - 1], TAB_ORDER[index + 1]];
              setVisited((current) =>
                next.every((tab) => !tab || current[tab])
                  ? current
                  : {
                      ...current,
                      ...Object.fromEntries(
                        next.filter(Boolean).map((tab) => [tab, true]),
                      ),
                    },
              );
            }}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { x: scrollX } } }],
              { useNativeDriver: true },
            )}
            onMomentumScrollEnd={(event) => {
              const index = Math.round(
                event.nativeEvent.contentOffset.x / pageWidth,
              );
              const tab = TAB_ORDER[index];
              if (tab) setActiveTab(tab);
            }}
            style={styles.flex}
          >
            {page(
              "home",
              <Home
                userName={userName}
                onOpenQr={() => selectTab("scan")}
                onOpenNotifications={() => setOverlay("notifications")}
                onOpenProfile={() => selectTab("profile")}
                onRefreshed={onBanned}
                unreadCount={center.unreadCount}
                isCurrentTab={activeTab === "home"}
              />,
            )}

            {page(
              "gyms",
              visited.gyms ? <Gyms active={activeTab === "gyms"} /> : null,
            )}

            {/* The camera mounts only while its tab is the settled active page. */}
            {page(
              "scan",
              activeTab === "scan" ? (
                integrity === null ? (
                  <View style={styles.loading}>
                    <ActivityIndicator
                      color={theme.colors.accent}
                      size="large"
                    />
                  </View>
                ) : integrity.compromised ? (
                  <DeviceBlocked onHome={() => selectTab("home")} />
                ) : (
                  <GateScan onBanned={onBanned} />
                )
              ) : null,
            )}

            {page(
              "tools",
              visited.tools ? (
                <Tools onFullscreenChange={setToolsFullscreen} />
              ) : null,
            )}

            {page(
              "profile",
              visited.profile ? (
                <Profile
                  fallbackName={userName}
                  onOpenSettings={() => setOverlay("settings")}
                />
              ) : null,
            )}
          </Animated.ScrollView>
        </TabSwipeLockContext.Provider>

        {toolsFullscreen ? null : (
          <BottomTabBar
            activeTab={activeTab}
            onTabChange={selectTab}
            scrollX={scrollX}
            pageWidth={pageWidth}
          />
        )}
      </BottomInsetProvider>

      {/* Pushed screens cover the tab bar, so the bottom inset does not apply. */}
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
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { ready: themeReady } = useThemeMode();
  const { data: session, isPending } = authClient.useSession();
  const [localizationReady, setLocalizationReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [screen, setScreen] = useState<ScreenState>({ name: "login" });
  const [integrity, setIntegrity] = useState<DeviceIntegrityResult | null>(
    null,
  );
  const hadSession = useRef(false);
  const lastUserId = useRef<string | null>(null);
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
      lastUserId.current = session.user.id;
      return;
    }
    if (hadSession.current) {
      hadSession.current = false;
      // Every path that loses the session passes through here: manual sign-out,
      // account deletion approval, revocation after sharing detection, or expiry.
      // Health data must not outlive the session on the device, so cleanup lives
      // here instead of Settings—the user ID is unavailable once the session ends.
      const userId = lastUserId.current;
      lastUserId.current = null;
      if (userId) void clearCalorieCalculatorState(userId);
      resetToLogin();
    }
  }, [resetToLogin, session]);

  useEffect(() => {
    void checkDeviceIntegrity().then(setIntegrity);
  }, []);

  const bootReady = localizationReady && themeReady && !isPending;

  let body: ReactNode;
  if (!bootReady) {
    body = <View style={styles.loading} />;
  } else if (session) {
    body = (
      <SignedInGate
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
        onSent={(email) => setScreen({ name: "resetCode", email })}
      />
    );
  } else if (screen.name === "resetCode") {
    const { email } = screen;
    body = (
      <VerifyResetCode
        email={email}
        onBack={resetToLogin}
        onVerified={(otp) => setScreen({ name: "reset", email, otp })}
      />
    );
  } else if (screen.name === "reset") {
    const { email } = screen;
    body = (
      <ResetPassword
        email={email}
        otp={screen.otp}
        onBack={() => setScreen({ name: "resetCode", email })}
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
      {session ? (
        body
      ) : (
        <BrandThemeScope>
          {body}
          {splashDone && bootReady ? <LanguageSwitcher floating /> : null}
        </BrandThemeScope>
      )}
      {splashDone ? null : (
        <Splash
          ready={bootReady}
          onFinish={() => setSplashDone(true)}
          exitTo={session ? "fade" : "band"}
          bandHeight={authBandHeight("tall", insets.top, windowHeight)}
        />
      )}
    </View>
  );
}

/**
 * Renders nothing and holds one app-lifetime subscription to better-auth's
 * session nanostores atom (`authClient.$store.atoms.session`). While that atom
 * has zero listeners, useSession()'s render-time `store.get()` mounts and
 * unmounts it, re-scheduling the internal session fetch around discarded
 * concurrent renders; React Native then logs "error during concurrent
 * rendering, recovered" on cold start. Keeping one permanent listener mounted
 * above every consumer means the atom activates exactly once and never tears
 * down while the app lives.
 */
function SessionStoreKeepAlive() {
  useEffect(() => {
    const sessionAtom = authClient.$store.atoms.session;
    return sessionAtom ? sessionAtom.listen(() => {}) : undefined;
  }, []);
  return null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionStoreKeepAlive />
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
    page: { overflow: "hidden" },
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
