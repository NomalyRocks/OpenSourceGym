import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { OtpInput } from "../components/OtpInput";
import {
  AuthShell,
  Button,
  ErrorMsg,
  Field,
  InfoMsg,
  LogoMark,
  PasswordField,
  styles,
} from "../ui";

export function ResetPassword({
  email,
  onDone,
  onBack,
}: {
  email: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  async function submit() {
    setError(null);
    setInfo(null);
    setOtpError(null);
    setPasswordError(null);
    setConfirmError(null);
    if (otp.length !== 6) {
      setOtpError(t("6 haneli doğrulama kodunu girin."));
      return;
    }
    if (password.length < 8) {
      setPasswordError(t("Şifre en az 8 karakter olmalı."));
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setConfirmError(t("Şifreler eşleşmiyor."));
      confirmRef.current?.focus();
      return;
    }
    await runAuthAction(setBusy, showUnreachable, async () => {
      const { error } = await authClient.emailOtp.resetPassword({
        email,
        otp,
        password,
      });
      if (error) {
        if (error.status === 429) {
          setError(t("Çok fazla deneme. Lütfen bir dakika bekleyin."));
        } else if (error.code === "INVALID_OTP") {
          setError(t("Kod hatalı."));
        } else if (error.code === "OTP_EXPIRED") {
          setError(t("Kodun süresi dolmuş."));
        } else if (error.code === "TOO_MANY_ATTEMPTS") {
          setError(t("Çok fazla hatalı deneme yapıldı. Yeni kod isteyin."));
        } else if (error.code === "PASSWORD_TOO_SHORT") {
          setError(t("Şifre en az 8 karakter olmalı."));
        } else {
          setError(t("Şifre sıfırlanamadı. Lütfen tekrar deneyin."));
        }
        return;
      }
      Alert.alert(t("Şifreniz güncellendi"), t("Yeni şifrenizle giriş yapın."));
      onDone();
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
    setError(null);
    setInfo(null);
    await runAuthAction(setResending, showUnreachable, async () => {
      const { error } = await authClient.emailOtp.requestPasswordReset({
        email,
      });
      if (error) {
        setError(
          error.status === 429
            ? t("Çok fazla deneme. Lütfen bir dakika bekleyin.")
            : t("İstek gönderilemedi. Lütfen tekrar deneyin."),
        );
        return;
      }
      setOtp("");
      setInfo(t("Yeni kod gönderildi."));
    });
  }

  return (
    <AuthShell
      footer={
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.link}>{t("Giriş ekranına dön")}</Text>
        </Pressable>
      }
    >
      <LogoMark />
      <Text style={styles.heading}>{t("Yeni şifre oluştur")}</Text>
      <Text style={styles.sub}>
        {t("{{email}} adresine gönderilen kodu ve yeni şifrenizi girin.", {
          email,
        })}
      </Text>

      <View style={{ marginTop: 24 }}>
        <ErrorMsg text={error} />
        <InfoMsg text={info} />
      </View>

      <View style={{ marginTop: error || info ? 0 : 8, gap: 16 }}>
        <Field label={t("E-posta")} value={email} editable={false} />
        <OtpInput
          value={otp}
          error={otpError}
          onChangeText={(value) => {
            setOtp(value);
            if (otpError) setOtpError(null);
          }}
        />
        <PasswordField
          inputRef={passwordRef}
          label={t("Yeni şifre (min. 8 karakter)")}
          value={password}
          error={passwordError}
          helperText={t("En az 8 karakter kullanın.")}
          onChangeText={(value) => {
            setPassword(value);
            if (passwordError) setPasswordError(null);
          }}
          autoComplete="new-password"
          returnKeyType="next"
          onSubmitEditing={() => confirmRef.current?.focus()}
        />
        <PasswordField
          inputRef={confirmRef}
          label={t("Yeni şifre (tekrar)")}
          value={confirm}
          error={confirmError}
          onChangeText={(value) => {
            setConfirm(value);
            if (confirmError) setConfirmError(null);
          }}
          autoComplete="new-password"
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />
      </View>

      <Button title={t("Şifreyi sıfırla")} onPress={submit} busy={busy} />
      <Pressable
        accessibilityRole="button"
        onPress={() => void resend()}
        disabled={resending}
      >
        <Text style={styles.link}>
          {resending ? t("Kod gönderiliyor...") : t("Kodu tekrar gönder")}
        </Text>
      </Pressable>
    </AuthShell>
  );
}
