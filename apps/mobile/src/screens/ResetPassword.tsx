import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View, type TextInput } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { useThemedStyles, type Theme } from "../theme";
import {
  AuthHeading,
  AuthShell,
  Button,
  ConfirmSheet,
  ErrorMsg,
  PasswordField,
} from "../ui";

/**
 * Second step of the password reset. The code was already checked on the
 * previous screen and is replayed here, because it is only consumed by the
 * reset call itself.
 */
export function ResetPassword({
  email,
  otp,
  onDone,
  onBack,
}: {
  email: string;
  otp: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(resetStyles);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  function showUnreachable() {
    setError(
      t("Could not connect. Check your internet connection and try again."),
    );
  }

  async function submit() {
    setError(null);
    setPasswordError(null);
    setConfirmError(null);
    if (password.length < 8) {
      setPasswordError(t("The password must be at least 8 characters."));
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setConfirmError(t("Passwords do not match."));
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
          setError(t("Too many attempts. Please wait one minute."));
        } else if (
          error.code === "INVALID_OTP" ||
          error.code === "OTP_EXPIRED" ||
          error.code === "TOO_MANY_ATTEMPTS"
        ) {
          // The code lapsed between the two steps; only a fresh one helps.
          setError(t("The code is no longer valid. Go back for a new one."));
        } else if (error.code === "PASSWORD_TOO_SHORT") {
          setError(t("The password must be at least 8 characters."));
        } else {
          setError(t("The password could not be reset. Please try again."));
        }
        return;
      }
      setDone(true);
    });
  }

  return (
    <AuthShell onBack={onBack}>
      <AuthHeading
        title={t("Create a new password")}
        subtitle={t("Choose a new password for {{email}}.", { email })}
      />

      {error ? (
        <View style={styles.errorSlot}>
          <ErrorMsg text={error} />
        </View>
      ) : null}

      <View style={styles.fields}>
        <PasswordField
          inputRef={passwordRef}
          label={t("New password (min. 8 characters)")}
          value={password}
          error={passwordError}
          helperText={t("Use at least 8 characters.")}
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
          label={t("Confirm new password")}
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

      <Button title={t("Reset password")} onPress={submit} busy={busy} />

      {/* Rendered here so the sheet stays inside the auth brand theme scope. */}
      <ConfirmSheet
        notice
        visible={done}
        title={t("Your password was updated")}
        body={
          <Text style={styles.noticeText}>
            {t("Sign in with your new password.")}
          </Text>
        }
        confirmLabel={t("Sign In")}
        onConfirm={onDone}
      />
    </AuthShell>
  );
}

const resetStyles = (theme: Theme) =>
  StyleSheet.create({
    noticeText: { ...theme.type.body, color: theme.colors.textSecondary },
    errorSlot: { marginTop: theme.spacing.lg },
    fields: {
      marginTop: theme.spacing.xl,
      marginBottom: theme.spacing.md,
      gap: theme.spacing.md,
    },
  });
