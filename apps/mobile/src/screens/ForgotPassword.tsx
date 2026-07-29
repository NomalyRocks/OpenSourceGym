import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { AuthShell, Button, ErrorMsg, Field, LogoMark, styles } from "../ui";

export function ForgotPassword({
  onBack,
  onSent,
}: {
  onBack: () => void;
  onSent: (email: string) => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);

  async function submit() {
    setError(null);
    if (!email) {
      setEmailError(t("E-posta adresinizi girin."));
      emailRef.current?.focus();
      return;
    }
    await runAuthAction(
      setBusy,
      () =>
        setError(
          t(
            "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
          ),
        ),
      async () => {
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
        onSent(email);
      },
    );
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
      <Text style={styles.heading}>{t("Şifreni yenile")}</Text>
      <Text style={styles.sub}>
        {t(
          "E-posta adresinizi girin, size bir şifre sıfırlama kodu gönderelim.",
        )}
      </Text>

      <View style={{ marginTop: 28 }}>
        <ErrorMsg text={error} />
      </View>

      <View style={{ marginTop: error ? 0 : 8 }}>
        <Field
          inputRef={emailRef}
          label={t("E-posta")}
          value={email}
          error={emailError}
          onChangeText={(value) => {
            setEmail(value);
            if (emailError) setEmailError(null);
          }}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
        />
      </View>

      <Button title={t("Sıfırlama kodu gönder")} onPress={submit} busy={busy} />
    </AuthShell>
  );
}
