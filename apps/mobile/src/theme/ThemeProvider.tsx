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
  /** User selection (including `system`). */
  mode: ThemeMode;
  /** Name resolved from the device when `mode === "system"`. */
  resolvedName: ThemeName;
  setMode: (mode: ThemeMode) => void;
  /** Whether storage loading is complete—the splash waits to prevent theme flicker. */
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
    // If the write fails, the selection remains valid for this session.
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
 * Style factory that runs once per theme.
 *
 * `factory` must be defined at module scope (an arrow function recreated on
 * every render breaks memoization).
 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}

/** Brand blue used by the splash and the auth halftone band. */
const BRAND_BLUE = "#0055FF";

/**
 * Re-skins the accent for everything below it with the brand blue (signed-out
 * screens), so controls match the halftone band in both modes. Dark mode also
 * lifts empty inputs off the page. Mode and `setMode` are inherited.
 */
export function BrandThemeScope({ children }: { children: ReactNode }) {
  const outer = useThemeContext();
  const value = useMemo<ThemeContextValue>(() => {
    const base = outer.theme;
    const dark = base.name === "dark";
    return {
      ...outer,
      theme: {
        ...base,
        colors: {
          ...base.colors,
          accent: BRAND_BLUE,
          accentPressed: "#0044CC",
          onAccent: "#FFFFFF",
          accentSurface: "rgba(0,85,255,0.14)",
          accentBorder: "rgba(0,85,255,0.42)",
          // #0055FF text is only ~3.5:1 on the dark page, so links go lighter.
          link: dark ? "#6E9BFF" : BRAND_BLUE,
          ...(dark
            ? { surfaceInput: base.colors.surface, outline: "#2f3238" }
            : null),
        },
        radius: { ...base.radius, control: 10, input: 10 },
      },
    };
  }, [outer]);
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
