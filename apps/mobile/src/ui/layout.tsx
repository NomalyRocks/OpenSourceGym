import { createContext, useContext, type ReactNode } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemedStyles, withAlpha, type Theme } from "../theme";
import { ChevronLeftGlyph } from "../components/icons";
import authArtwork from "../../assets/auth-equipment.webp";

/**
 * Ekran gövdelerinin alt tarafına eklenmesi gereken pay.
 *
 * Yüzen sekme çubuğu içeriğin üstünde durduğu için, altında kalan son satır
 * onun ardında kaybolur. Değeri sağlayan `SignedInApp`; `Screen` ve
 * `ScrollScreen` buradan okur, böylece her ekranda ayrı ayrı hatırlanması
 * gerekmez. Sekme çubuğunu kapatan itilen ekranlar payı 0'a çeker.
 */
const BottomInsetContext = createContext(0);

export function BottomInsetProvider({
  value,
  children,
}: {
  value: number;
  children: ReactNode;
}) {
  return (
    <BottomInsetContext.Provider value={value}>
      {children}
    </BottomInsetContext.Provider>
  );
}

/** Marka işareti: vurgu dolgulu squircle, üstünde sıkı aralıklı "oG". */
export function LogoMark({
  size = 56,
  ringed = false,
}: {
  size?: number;
  /** Fotoğraf bandıyla sayfa arasında otururken sayfa renginde halka alır. */
  ringed?: boolean;
}) {
  const theme = useTheme();
  const ring = ringed ? 4 : 0;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size + ring * 2,
        height: size + ring * 2,
        borderRadius: (size + ring * 2) * 0.31,
        backgroundColor: ringed ? theme.colors.background : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.29,
          backgroundColor: theme.colors.accent,
          experimental_backgroundImage: `linear-gradient(145deg, ${theme.colors.accent}, ${theme.colors.accentPressed})`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          maxFontSizeMultiplier={1.2}
          style={{
            fontSize: size * 0.34,
            lineHeight: size * 0.42,
            fontWeight: "700",
            color: theme.colors.onAccent,
            letterSpacing: -size * 0.018,
          }}
        >
          oG
        </Text>
      </View>
    </View>
  );
}

/**
 * Kimlik ekranlarının kabuğu.
 *
 * Üstte sınırlı bir fotoğraf bandı, altında sayfa rengine inen degrade; marka
 * işareti tam sınırın üstünde oturur. Fotoğrafın hayalet gibi tüm arkaya
 * yayılması yerine bandın sınırlı olması iki temada da okunur kalmasını sağlar.
 */
export function AuthShell({
  children,
  footer,
  onBack,
}: {
  children: ReactNode;
  footer?: ReactNode;
  onBack?: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(layoutStyles);
  const insets = useSafeAreaInsets();
  const bandHeight = insets.top + 156;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={[styles.authBand, { height: bandHeight }]}
        pointerEvents="none"
      >
        <Image
          source={authArtwork}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              experimental_backgroundImage: `linear-gradient(180deg, ${withAlpha(
                theme.colors.background,
                theme.name === "dark" ? 0.34 : 0.1,
              )} 0%, ${withAlpha(theme.colors.background, 0.82)} 62%, ${
                theme.colors.background
              } 100%)`,
            },
          ]}
        />
      </View>

      {onBack ? (
        <View style={[styles.authBack, { top: insets.top + 4 }]}>
          <BackButton onPress={onBack} />
        </View>
      ) : null}

      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.authContent,
          {
            paddingTop: bandHeight - 32,
            paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        automaticallyAdjustKeyboardInsets
      >
        <LogoMark ringed />
        <View style={styles.authBody}>{children}</View>
        {footer ? <View style={styles.authFooter}>{footer}</View> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function AuthHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const styles = useThemedStyles(layoutStyles);
  return (
    <View style={styles.authHeading}>
      <Text accessibilityRole="header" style={styles.authTitle}>
        {title}
      </Text>
      {subtitle ? <Text style={styles.authSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** "Hesabın yok mu? Kayıt ol" gibi tek satırlık alt eylem. */
export function AuthFooterLink({
  prompt,
  actionLabel,
  onPress,
}: {
  prompt: string;
  actionLabel: string;
  onPress: () => void;
}) {
  const styles = useThemedStyles(layoutStyles);
  return (
    <View style={styles.authFooterRow}>
      <Text style={styles.authFooterText}>{prompt}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onPress}
        hitSlop={10}
        style={({ pressed }) => [
          styles.authFooterAction,
          pressed && styles.pressedSoft,
        ]}
      >
        <Text style={styles.authFooterActionLabel}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(layoutStyles);
  const { t } = useTranslation();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Geri")}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.iconWell, pressed && styles.pressedWell]}
    >
      <ChevronLeftGlyph size={20} color={theme.colors.textPrimary} />
    </Pressable>
  );
}

/** Sekme köklerinde ve itilen ekranlarda ortak başlık. */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  trailing,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: ReactNode;
}) {
  const styles = useThemedStyles(layoutStyles);

  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        {onBack ? (
          <View style={styles.headerLeading}>
            <BackButton onPress={onBack} />
          </View>
        ) : null}
        <View style={styles.flex}>
          <Text accessibilityRole="header" style={styles.headerTitle}>
            {title}
          </Text>
        </View>
        {trailing ? (
          <View style={styles.headerTrailing}>{trailing}</View>
        ) : null}
      </View>
      {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** Kaydırmayan ekran gövdesi. */
export function Screen({
  children,
  style,
  edges = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Üst güvenli alan boşluğunu uygula. */
  edges?: boolean;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(layoutStyles);
  const insets = useSafeAreaInsets();
  const bottomInset = useContext(BottomInsetContext);

  return (
    <View
      style={[
        styles.screen,
        { paddingBottom: theme.spacing.lg + bottomInset },
        edges && { paddingTop: insets.top + theme.spacing.md },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Kaydırılan ekran gövdesi; sekme köklerinin ortak kabı. */
export function ScrollScreen({
  children,
  refreshing,
  onRefresh,
  contentStyle,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(layoutStyles);
  const insets = useSafeAreaInsets();
  const bottomInset = useContext(BottomInsetContext);

  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={[
        styles.screenScrollContent,
        {
          paddingTop: insets.top + theme.spacing.md,
          paddingBottom: theme.spacing.xxl + bottomInset,
        },
        contentStyle,
      ]}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing ?? false}
            onRefresh={onRefresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surface}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

/**
 * Zeminden bir kademe yükselen yüzey. İç içe geçmez — bir plakanın içindeki
 * gruplama `Divider` ve boşlukla yapılır.
 */
export function Plate({
  children,
  style,
  tone = "surface",
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: "surface" | "accent" | "error";
  padded?: boolean;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(layoutStyles);

  return (
    <View
      style={[
        styles.plate,
        tone === "accent" && {
          backgroundColor: theme.colors.accentSurface,
          borderColor: theme.colors.accentBorder,
        },
        tone === "error" && {
          backgroundColor: theme.colors.errorSurface,
          borderColor: withAlpha(theme.colors.error, 0.28),
        },
        padded && { padding: theme.spacing.lg },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionHeading({
  title,
  trailing,
  style,
}: {
  title: string;
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(layoutStyles);
  return (
    <View style={[styles.sectionHeading, style]}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const styles = useThemedStyles(layoutStyles);
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

/** Boş durum: neyin olmadığını değil, ekranın ne yaptığını anlatır. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const styles = useThemedStyles(layoutStyles);
  return (
    <View style={styles.empty}>
      {icon ? <View style={styles.emptyIcon}>{icon}</View> : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

const layoutStyles = (theme: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    screen: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingHorizontal: theme.spacing.gutter,
      paddingBottom: theme.spacing.lg,
    },
    screenScroll: { flex: 1, backgroundColor: theme.colors.background },
    screenScrollContent: {
      paddingHorizontal: theme.spacing.gutter,
      paddingBottom: theme.spacing.xxl,
    },

    authBand: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.surface,
      overflow: "hidden",
    },
    // Fotoğraf bandının üstünde duruyor: ikon rengi tek başına her karede
    // okunur olmayacağı için kendi opak zeminini taşır.
    authBack: {
      position: "absolute",
      left: theme.spacing.md,
      zIndex: 10,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.surface,
      ...theme.shadows.plate,
    },
    authContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.xl,
    },
    authBody: { flexGrow: 1 },
    authFooter: { paddingTop: theme.spacing.xl },
    authHeading: { marginTop: theme.spacing.lg },
    authTitle: { ...theme.type.screenTitle, color: theme.colors.textPrimary },
    authSubtitle: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xxs,
      maxWidth: 340,
    },
    authFooterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      alignItems: "center",
      gap: theme.spacing.xxs,
    },
    authFooterText: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
    authFooterAction: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.xxs,
    },
    authFooterActionLabel: {
      ...theme.type.supporting,
      fontWeight: "700",
      color: theme.colors.accent,
    },

    header: { marginBottom: theme.spacing.lg },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      minHeight: 44,
    },
    headerLeading: { marginLeft: -theme.spacing.xs },
    headerTrailing: { flexDirection: "row", gap: theme.spacing.xs },
    headerTitle: {
      ...theme.type.screenTitle,
      color: theme.colors.textPrimary,
    },
    headerSubtitle: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xxs,
      maxWidth: 420,
    },

    iconWell: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.control,
      alignItems: "center",
      justifyContent: "center",
    },
    pressedWell: { backgroundColor: theme.colors.pressedOverlay },
    pressedSoft: { opacity: 0.6 },

    plate: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.card,
      borderWidth: theme.name === "dark" ? StyleSheet.hairlineWidth : 0,
      borderColor: theme.colors.outline,
      ...theme.shadows.plate,
    },

    sectionHeading: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    sectionTitle: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
      flexShrink: 1,
    },

    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.outline,
    },

    empty: {
      alignItems: "center",
      paddingVertical: theme.spacing.xxl,
      paddingHorizontal: theme.spacing.lg,
    },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.md,
    },
    emptyTitle: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
      textAlign: "center",
    },
    emptyBody: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.xxs,
      maxWidth: 300,
    },
    emptyAction: { marginTop: theme.spacing.lg, alignSelf: "stretch" },
  });
