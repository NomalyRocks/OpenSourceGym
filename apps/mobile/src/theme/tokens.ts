/**
 * OpenGym tasarım jetonları.
 *
 * Renkler OKLCH'te tasarlandı, RN'in kabul ettiği sRGB hex'e çevrildi. Marka
 * tonu 268° (ültramarin): salonun "geçiş kartı" işi burada — vurgu rengi
 * yeşil/kehribar/kırmızı durum üçlüsünden hue olarak uzakta durur, böylece bir
 * rozetin "durum" mu yoksa "marka" mı olduğu asla karışmaz.
 *
 * Ölçek ve boşluklar temadan bağımsızdır; yalnızca `ThemeColors` ve `shadow`
 * açık/koyu arasında değişir.
 */

export type ThemeName = "light" | "dark";
/** Kullanıcının seçimi: cihazı takip et ya da sabitle. */
export type ThemeMode = "system" | "light" | "dark";

export interface ThemeColors {
  /** Sayfa zemini. */
  background: string;
  /** Zeminden bir kademe yükselen panel/plaka. */
  surface: string;
  /** Panel içindeki ikinci kademe (çip, segment, avatar kuyusu). */
  surfaceRaised: string;
  /** Form girdisi zemini. */
  surfaceInput: string;

  /** Dekoratif ayraç ve kenarlık. */
  outline: string;
  /** Etkileşimli kontrol kenarlığı. */
  outlineStrong: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;

  /** Marka vurgusu: birincil eylem, seçili durum, odak halkası. Dekorasyon değil. */
  accent: string;
  accentPressed: string;
  /** Vurgunun düşük opaklıklı zemini (seçili satır, ikon kuyusu). */
  accentSurface: string;
  accentBorder: string;
  onAccent: string;

  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  error: string;
  errorSurface: string;

  /** Modal arkası karartma. */
  scrim: string;
  /** Basılı hâl için üste binen ton. */
  pressedOverlay: string;
  skeleton: string;
  /** Kamera/QR gibi her zaman koyu kalan yüzeyler. */
  alwaysDarkSurface: string;
  onAlwaysDark: string;
}

const darkColors: ThemeColors = {
  background: "#090a0d",
  surface: "#111316",
  surfaceRaised: "#1b1c21",
  surfaceInput: "#0d0f13",

  outline: "#282a2f",
  outlineStrong: "#3e4148",

  textPrimary: "#f2f3f5",
  textSecondary: "#b3b6bd",
  textTertiary: "#8d9199",
  textDisabled: "#666971",

  accent: "#7899f8",
  accentPressed: "#6586e7",
  accentSurface: "rgba(120,153,248,0.16)",
  accentBorder: "rgba(120,153,248,0.38)",
  onAccent: "#080d1a",

  success: "#6dd17f",
  successSurface: "rgba(109,209,127,0.14)",
  warning: "#ecba56",
  warningSurface: "rgba(236,186,86,0.14)",
  error: "#fa6c69",
  errorSurface: "rgba(250,108,105,0.14)",

  scrim: "rgba(4,5,7,0.72)",
  pressedOverlay: "rgba(242,243,245,0.08)",
  skeleton: "#1b1c21",
  alwaysDarkSurface: "#0d0f13",
  onAlwaysDark: "#f2f3f5",
};

const lightColors: ThemeColors = {
  background: "#f6f8fb",
  surface: "#ffffff",
  surfaceRaised: "#eff1f6",
  surfaceInput: "#ffffff",

  outline: "#dbdee4",
  outlineStrong: "#bfc2cb",

  textPrimary: "#161921",
  textSecondary: "#525762",
  textTertiary: "#696d77",
  textDisabled: "#9598a1",

  accent: "#3957cc",
  accentPressed: "#2a44bc",
  accentSurface: "rgba(57,87,204,0.10)",
  accentBorder: "rgba(57,87,204,0.28)",
  onAccent: "#ffffff",

  success: "#0b7d32",
  successSurface: "rgba(11,125,50,0.10)",
  warning: "#a06306",
  warningSurface: "rgba(160,99,6,0.10)",
  error: "#c9222b",
  errorSurface: "rgba(201,34,43,0.09)",

  scrim: "rgba(22,25,33,0.44)",
  pressedOverlay: "rgba(22,25,33,0.06)",
  skeleton: "#e6e9f0",
  alwaysDarkSurface: "#0d0f13",
  onAlwaysDark: "#f2f3f5",
};

/**
 * `#rrggbb` jetonunu `rgba()`'ya çevirir — degrade duraklarında ve üste binen
 * tonlarda gerekiyor, çünkü RN renk dizgilerinde alfa ayrı verilemiyor.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface ShadowStyle {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
}

export interface ThemeShadows {
  /** Zeminden ayrılan plaka. */
  plate: ShadowStyle;
  /** Sekme çubuğu / yapışkan başlık gibi üstte duran katman. */
  raised: ShadowStyle;
}

const noShadow: ShadowStyle = {
  shadowColor: "transparent",
  shadowOpacity: 0,
  shadowRadius: 0,
  shadowOffset: { width: 0, height: 0 },
  elevation: 0,
};

// Koyu temada derinliği gölge değil yüzey açıklığı taşır: siyah üstüne gölge
// görünmez, `elevation` ise Android'de yüzeyi gri yapar.
const darkShadows: ThemeShadows = { plate: noShadow, raised: noShadow };

const lightShadows: ThemeShadows = {
  plate: {
    shadowColor: "#0b1020",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // Yüzen sekme çubuğu: gölge aşağı düşer, zeminden ayrıldığı okunsun.
  raised: {
    shadowColor: "#0b1020",
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
};

export const radius = {
  pill: 999,
  card: 16,
  control: 14,
  input: 12,
  small: 10,
  tiny: 8,
} as const;

/** 4pt ölçek. */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  /** Ekran kenar boşluğu. */
  gutter: 20,
} as const;

/**
 * Tek aile (sistem sans), sabit ölçek, ~1.15 adım oranı. Ürün arayüzü
 * display/body eşleşmesi istemez; ayrım ağırlık ve renkle taşınır.
 */
export const type = {
  display: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "700" as const,
    letterSpacing: -0.8,
  },
  metric: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: "700" as const,
    letterSpacing: -1.2,
  },
  screenTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "700" as const,
    letterSpacing: -0.5,
  },
  sectionTitle: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: "700" as const,
    letterSpacing: -0.3,
  },
  title: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "600" as const,
    letterSpacing: -0.1,
  },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  supporting: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
  /** Yalnızca rozet ve durum çipi. Bölüm başlığı üstünde etiket olarak kullanma. */
  micro: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700" as const,
    letterSpacing: 0.4,
  },
} as const;

/** Sayaç, tarih ve süre metinleri zıplamasın diye. */
export const tabularNumbers = { fontVariant: ["tabular-nums" as const] };

export const motion = {
  instant: 0,
  quick: 140,
  standard: 200,
  slow: 280,
  /** Splash markası için tek seferlik daha uzun süre. */
  splash: 420,
} as const;

export interface Theme {
  name: ThemeName;
  colors: ThemeColors;
  shadows: ThemeShadows;
  radius: typeof radius;
  spacing: typeof spacing;
  type: typeof type;
  motion: typeof motion;
  /** expo-status-bar `style` değeri. */
  statusBarStyle: "light" | "dark";
}

export const themes: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    colors: darkColors,
    shadows: darkShadows,
    radius,
    spacing,
    type,
    motion,
    statusBarStyle: "light",
  },
  light: {
    name: "light",
    colors: lightColors,
    shadows: lightShadows,
    radius,
    spacing,
    type,
    motion,
    statusBarStyle: "dark",
  },
};
