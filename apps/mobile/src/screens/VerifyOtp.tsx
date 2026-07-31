import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { getDeviceFingerprint } from "../lib/fingerprint";
import { EnvelopeGlyph } from "../components/icons";
import { OtpInput } from "../components/OtpInput";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import { AuthHeading, AuthShell, Button, ErrorMsg, InfoMsg } from "../ui";

const RESEND_COOLDOWN_SECONDS = 30;

export function VerifyOtp({
  email,
  password,
  onBack,
  onVerified,
}: {
  email: string;
  password: string;
  onBack: () => void;
  onVerified: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(verifyStyles);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function submit() {
    setError(null);
    await runAuthAction(setBusy, showUnreachable, async () => {
      const { error } = await authClient.emailOtp.verifyEmail({ email, otp });
      if (error) {
        setError(t("Kod hatalı veya süresi dolmuş."));
        return;
      }
      // Doğrulama sonrası otomatik giriş — kayıt akışı kesintisiz tamamlanır
      const fp = await getDeviceFingerprint();
      const signIn = await authClient.signIn.email({
        email,
        password,
        fetchOptions: fp
          ? { headers: { "X-Device-Fingerprint": fp } }
          : undefined,
      });
      if (signIn.error) {
        setError(
          t("Doğrulama tamam; giriş başarısız. Giriş ekranından deneyin."),
        );
        return;
      }
      onVerified();
    });
  }

  function showUnreachable() {
    setError(
      t(
        "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
      ),
    );
  }

  async function resend() {
    if (secondsLeft > 0) return;
    setInfo(null);
    setError(null);
    await runAuthAction(setResending, showUnreachable, async () => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      });
      if (error) {
        setError(t("Kod gönderilemedi. Lütfen bir dakika bekleyin."));
      } else {
        setOtp("");
        setInfo(t("Yeni kod gönderildi."));
        setSecondsLeft(RESEND_COOLDOWN_SECONDS);
      }
    });
  }

  const cooling = secondsLeft > 0;

  return (
    <AuthShell onBack={onBack}>
      <AuthHeading
        title={t("Doğrulama Kodu")}
        subtitle={t("Gelen kutuna 6 haneli bir kod gönderdik.")}
      />

      <View style={styles.recipient}>
        <EnvelopeGlyph size={18} color={theme.colors.textSecondary} />
        <Text style={styles.recipientText} numberOfLines={1}>
          {email}
        </Text>
      </View>

      {error || info ? (
        <View style={styles.messages}>
          <ErrorMsg text={error} />
          <InfoMsg text={info} />
        </View>
      ) : null}

      <View style={styles.otp}>
        <OtpInput value={otp} onChangeText={setOtp} autoFocus />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: cooling || resending }}
        accessibilityLabel={t("Kodu tekrar gönder")}
        onPress={() => void resend()}
        disabled={cooling || resending}
        hitSlop={8}
        style={({ pressed }) => [styles.resend, pressed && styles.pressed]}
      >
        <Text style={[styles.resendLabel, cooling && styles.resendLabelIdle]}>
          {t("Kodu tekrar gönder")}
        </Text>
        {cooling ? (
          <Text style={styles.countdown}>
            {`00:${String(secondsLeft).padStart(2, "0")}`}
          </Text>
        ) : null}
      </Pressable>

      <Button
        title={t("Doğrula")}
        onPress={submit}
        busy={busy}
        disabled={otp.length !== 6}
      />
    </AuthShell>
  );
}

const verifyStyles = (theme: Theme) =>
  StyleSheet.create({
    recipient: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      maxWidth: "100%",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.md,
      paddingVertical: 7,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.colors.surfaceRaised,
    },
    recipientText: {
      ...theme.type.label,
      color: theme.colors.textSecondary,
      flexShrink: 1,
    },
    messages: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
    otp: { marginTop: theme.spacing.xl },
    resend: {
      minHeight: 48,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
    },
    resendLabel: { ...theme.type.supporting, color: theme.colors.accent },
    resendLabelIdle: { color: theme.colors.textTertiary },
    countdown: {
      ...theme.type.label,
      ...tabularNumbers,
      color: theme.colors.textSecondary,
    },
    pressed: { opacity: 0.6 },
  });
