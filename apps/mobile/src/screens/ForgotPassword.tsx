import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View, type TextInput } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { useThemedStyles, type Theme } from "../theme";
import {
  AuthFooterLink,
  AuthHeading,
  AuthShell,
  Button,
  ErrorMsg,
  Field,
} from "../ui";

export function ForgotPassword({
  onBack,
  onSent,
}: {
  onBack: () => void;
  onSent: (email: string) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(forgotStyles);
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
      onBack={onBack}
      footer={
        <AuthFooterLink
          prompt={t("Şifreni hatırladın mı?")}
          actionLabel={t("Giriş Yap")}
          onPress={onBack}
        />
      }
    >
      <AuthHeading
        title={t("Şifreni yenile")}
        subtitle={t(
          "E-posta adresinizi girin, size bir şifre sıfırlama kodu gönderelim.",
        )}
      />

      {error ? (
        <View style={styles.errorSlot}>
          <ErrorMsg text={error} />
        </View>
      ) : null}

      <View style={styles.fields}>
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

const forgotStyles = (theme: Theme) =>
  StyleSheet.create({
    errorSlot: { marginTop: theme.spacing.lg },
    fields: { marginTop: theme.spacing.xl, marginBottom: theme.spacing.md },
  });
