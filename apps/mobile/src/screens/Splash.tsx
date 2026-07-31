import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useThemedStyles, type Theme } from "../theme";
import { easing, useReducedMotion } from "../ui";

/** Marka gösterisi bitmeden kapanmasın; ama uygulama hazırsa da oyalanmasın. */
const INTRO_MS = 720;
const EXIT_MS = 220;

/**
 * Açılış ekranı.
 *
 * Native splash yerine JS katmanında duruyor: `expo-splash-screen` eklemek
 * dev-client rebuild'i gerektirirdi. Görevi süslemek değil, oturum ve tema
 * okuması bitene kadar boş bir kareyi göstermemek — bu yüzden `ready`
 * gelmeden kapanmaz.
 */
export function Splash({
  ready,
  onFinish,
}: {
  ready: boolean;
  onFinish: () => void;
}) {
  const styles = useThemedStyles(splashStyles);
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [introDone, setIntroDone] = useState(false);

  const enter = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: reduced ? 120 : INTRO_MS,
      easing: easing.out,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setIntroDone(true);
    });
    return () => animation.stop();
  }, [enter, reduced]);

  useEffect(() => {
    if (!introDone || !ready) return;
    const animation = Animated.timing(exit, {
      toValue: 0,
      duration: reduced ? 90 : EXIT_MS,
      easing: easing.in,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onFinish();
    });
    return () => animation.stop();
  }, [exit, introDone, onFinish, ready, reduced]);

  const markStyle = {
    opacity: enter,
    transform: reduced
      ? []
      : [
          {
            scale: enter.interpolate({
              inputRange: [0, 1],
              outputRange: [0.9, 1],
            }),
          },
        ],
  };

  const wordmarkStyle = {
    opacity: enter.interpolate({
      inputRange: [0, 0.45, 1],
      outputRange: [0, 0, 1],
    }),
    transform: reduced
      ? []
      : [
          {
            translateY: enter.interpolate({
              inputRange: [0, 0.45, 1],
              outputRange: [10, 10, 0],
            }),
          },
        ],
  };

  return (
    <Animated.View style={[styles.root, { opacity: exit }]}>
      <View style={styles.center}>
        <Animated.View style={[styles.mark, markStyle]}>
          <Text style={styles.markText} maxFontSizeMultiplier={1.1}>
            oG
          </Text>
        </Animated.View>
        <Animated.View style={wordmarkStyle}>
          <Text style={styles.wordmark} maxFontSizeMultiplier={1.3}>
            OpenGym
          </Text>
          <Text style={styles.tagline} maxFontSizeMultiplier={1.4}>
            {t("Üyeliğin ve turnike geçişin tek yerde")}
          </Text>
        </Animated.View>
      </View>

      {/* Yükleme göstergesi yalnızca gecikme uzarsa anlam taşır; giriş
          animasyonu bittiği hâlde uygulama hazır değilse belirir. */}
      {introDone && !ready ? (
        <View style={styles.footer}>
          <Text style={styles.footerText}>{t("Hazırlanıyor…")}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const splashStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.colors.background,
      alignItems: "center",
      justifyContent: "center",
      // zIndex tek başına yetmez: Android sıralamayı `elevation` ile yapar.
      zIndex: 100,
      elevation: 32,
    },
    center: { alignItems: "center", paddingHorizontal: theme.spacing.xl },
    mark: {
      width: 76,
      height: 76,
      borderRadius: 22,
      backgroundColor: theme.colors.accent,
      experimental_backgroundImage: `linear-gradient(145deg, ${theme.colors.accent}, ${theme.colors.accentPressed})`,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.lg,
    },
    markText: {
      fontSize: 27,
      lineHeight: 33,
      fontWeight: "700",
      letterSpacing: -1,
      color: theme.colors.onAccent,
    },
    wordmark: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
      textAlign: "center",
    },
    tagline: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.xxs,
      maxWidth: 260,
    },
    footer: {
      position: "absolute",
      bottom: theme.spacing.xxxl,
      alignItems: "center",
    },
    footerText: {
      ...theme.type.supporting,
      color: theme.colors.textTertiary,
    },
  });
