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
      setEmailError(t("Enter your email address."));
      emailRef.current?.focus();
      return;
    }
    await runAuthAction(
      setBusy,
      () =>
        setError(
          t("Could not connect. Check your internet connection and try again."),
        ),
      async () => {
        const { error } = await authClient.emailOtp.requestPasswordReset({
          email,
        });
        if (error) {
          setError(
            error.status === 429
              ? t("Too many attempts. Please wait one minute.")
              : t("The request could not be sent. Please try again."),
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
          prompt={t("Remembered your password?")}
          actionLabel={t("Sign In")}
          onPress={onBack}
        />
      }
    >
      <AuthHeading
        title={t("Reset your password")}
        subtitle={t(
          "Enter your email address and we will send you a password reset code.",
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
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
        />
      </View>

      <Button title={t("Send reset code")} onPress={submit} busy={busy} />
    </AuthShell>
  );
}

const forgotStyles = (theme: Theme) =>
  StyleSheet.create({
    errorSlot: { marginTop: theme.spacing.lg },
    fields: { marginTop: theme.spacing.xl, marginBottom: theme.spacing.md },
  });
