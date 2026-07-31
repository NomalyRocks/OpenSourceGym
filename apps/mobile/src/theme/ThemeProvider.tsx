import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { themes, type Theme, type ThemeMode, type ThemeName } from "./tokens";

const STORAGE_KEY = "opengym.theme-mode";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

interface ThemeContextValue {
  theme: Theme;
  /** Kullanıcının seçimi (`system` dâhil). */
  mode: ThemeMode;
  /** `mode === "system"` iken cihazdan çözülen ad. */
  resolvedName: ThemeName;
  setMode: (mode: ThemeMode) => void;
  /** Depodan okuma bitti mi — splash bunu bekler, böylece tema takırdamaz. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(STORAGE_KEY)
      .catch(() => null)
      .then((stored) => {
        if (cancelled) return;
        if (isThemeMode(stored)) setModeState(stored);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    // Yazma başarısız olursa seçim yine de bu oturum boyunca geçerli kalır.
    void SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const resolvedName: ThemeName =
    mode === "system" ? (systemScheme === "light" ? "light" : "dark") : mode;

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: themes[resolvedName],
      mode,
      resolvedName,
      setMode,
      ready,
    }),
    [mode, ready, resolvedName, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return context;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemeMode(): Pick<
  ThemeContextValue,
  "mode" | "resolvedName" | "setMode" | "ready"
> {
  const { mode, resolvedName, setMode, ready } = useThemeContext();
  return { mode, resolvedName, setMode, ready };
}

/**
 * Tema başına bir kez çalışan stil fabrikası.
 *
 * `factory` modül kapsamında tanımlanmalı (her render'da yeniden kurulan bir
 * arrow function memoizasyonu bozar).
 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
