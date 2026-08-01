import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { getDeviceFingerprint } from "../lib/fingerprint";
import { useThemedStyles, type Theme } from "../theme";
import {
  AuthFooterLink,
  AuthHeading,
  AuthShell,
  Button,
  ErrorMsg,
  Field,
  PasswordField,
} from "../ui";

export function Login({
  onRegister,
  onNeedsVerification,
  onForgot,
}: {
  onRegister: () => void;
  onNeedsVerification: (email: string, password: string) => void;
  onForgot: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(loginStyles);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit() {
    setError(null);
    const nextEmailError = email.trim() ? null : t("E-posta adresinizi girin.");
    const nextPasswordError = password ? null : t("Şifrenizi girin.");
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError || nextPasswordError) {
      (nextEmailError ? emailRef : passwordRef).current?.focus();
      return;
    }

    await runAuthAction(setBusy, showUnreachable, async () => {
      const fp = await getDeviceFingerprint();
      const { error } = await authClient.signIn.email({
        email,
        password,
        fetchOptions: fp
          ? { headers: { "X-Device-Fingerprint": fp } }
          : undefined,
      });
      if (error) {
        if (error.code === "EMAIL_NOT_VERIFIED") {
          await authClient.emailOtp.sendVerificationOtp({
            email,
            type: "email-verification",
          });
          onNeedsVerification(email, password);
          return;
        }
        setError(
          error.status === 429
            ? t("Çok fazla deneme. Lütfen bir dakika bekleyin.")
            : t("E-posta veya şifre hatalı."),
        );
      }
    });
  }

  function showUnreachable() {
    setError(
      t(
        "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
      ),
    );
  }

  return (
    <AuthShell
      footer={
        <AuthFooterLink
          prompt={t("Hesabın yok mu?")}
          actionLabel={t("Kayıt Ol")}
          onPress={onRegister}
        />
      }
    >
      <AuthHeading
        title={t("Tekrar hoş geldin")}
        subtitle={t("Üyeliğini kontrol et ve salona giriş yap")}
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
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <PasswordField
          inputRef={passwordRef}
          label={t("Şifre")}
          value={password}
          error={passwordError}
          onChangeText={(value) => {
            setPassword(value);
            if (passwordError) setPasswordError(null);
          }}
          autoComplete="current-password"
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onForgot}
        hitSlop={6}
        style={({ pressed }) => [styles.forgot, pressed && styles.pressed]}
      >
        <Text style={styles.forgotLabel}>{t("Şifremi unuttum")}</Text>
      </Pressable>

      <Button title={t("Giriş Yap")} onPress={submit} busy={busy} />
    </AuthShell>
  );
}

const loginStyles = (theme: Theme) =>
  StyleSheet.create({
    errorSlot: { marginTop: theme.spacing.lg },
    fields: { marginTop: theme.spacing.xl, gap: theme.spacing.md },
    forgot: {
      alignSelf: "flex-end",
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.xxs,
      marginBottom: theme.spacing.xs,
    },
    forgotLabel: { ...theme.type.supporting, color: theme.colors.accent },
    pressed: { opacity: 0.6 },
  });
