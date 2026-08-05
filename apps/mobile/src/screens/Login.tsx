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
    const nextEmailError = email.trim() ? null : t("Enter your email address.");
    const nextPasswordError = password ? null : t("Enter your password.");
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
            ? t("Too many attempts. Please wait one minute.")
            : t("The email or password is incorrect."),
        );
      }
    });
  }

  function showUnreachable() {
    setError(
      t("Could not connect. Check your internet connection and try again."),
    );
  }

  return (
    <AuthShell
      footer={
        <AuthFooterLink
          prompt={t("Don't have an account?")}
          actionLabel={t("Sign Up")}
          onPress={onRegister}
        />
      }
    >
      <AuthHeading
        title={t("Welcome back")}
        subtitle={t("Check your membership and enter the gym")}
      />

      {error ? (
        <View style={styles.errorSlot}>
          <ErrorMsg text={error} />
        </View>
      ) : null}

      <View style={styles.fields}>
        <Field
          inputRef={emailRef}
          label={t("Email")}
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
          label={t("Password")}
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
        <Text style={styles.forgotLabel}>{t("Forgot password")}</Text>
      </Pressable>

      <Button title={t("Sign In")} onPress={submit} busy={busy} />
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
