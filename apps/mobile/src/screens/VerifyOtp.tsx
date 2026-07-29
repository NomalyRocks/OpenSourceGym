import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { getDeviceFingerprint } from "../lib/fingerprint";
import { EnvelopeGlyph } from "../components/icons";
import { OtpInput } from "../components/OtpInput";
import { colors } from "../theme";
import { AuthShell, Button, ErrorMsg, InfoMsg, styles } from "../ui";

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

  return (
    <AuthShell
      footer={
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.link}>{t("Geri dön")}</Text>
        </Pressable>
      }
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.input,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "center",
        }}
      >
        <EnvelopeGlyph size={22} color={colors.ink} />
      </View>

      <Text style={[styles.heading, { marginTop: 22, textAlign: "center" }]}>
        {t("Doğrulama Kodu")}
      </Text>
      <Text style={[styles.sub, { marginTop: 8, textAlign: "center" }]}>
        {t("{{email}} adresinize gönderilen 6 haneli kodu girin", { email })}
      </Text>

      <View style={{ marginTop: 20, width: "100%" }}>
        <ErrorMsg text={error} />
        <InfoMsg text={info} />
      </View>

      <View style={{ marginTop: error || info ? 0 : 32, alignItems: "center" }}>
        <OtpInput value={otp} onChangeText={setOtp} autoFocus />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => void resend()}
        disabled={secondsLeft > 0 || resending}
        hitSlop={8}
        style={{ minHeight: 48, marginTop: 16, justifyContent: "center" }}
      >
        <Text
          style={{
            color: secondsLeft > 0 ? colors.inkDim : colors.ink,
            fontSize: 13.5,
            textAlign: "center",
          }}
        >
          {t("Kodu tekrar gönder")}{" "}
          {secondsLeft > 0 && (
            <Text style={{ fontWeight: "700" }}>
              {`00:${String(secondsLeft).padStart(2, "0")}`}
            </Text>
          )}
        </Text>
      </Pressable>

      <Button title={t("Doğrula")} onPress={submit} busy={busy} />
    </AuthShell>
  );
}
