import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextInput,
} from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { OtpInput } from "../components/OtpInput";
import { useThemedStyles, type Theme } from "../theme";
import {
  AuthHeading,
  AuthShell,
  Button,
  ErrorMsg,
  InfoMsg,
  PasswordField,
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
  const styles = useThemedStyles(resetStyles);
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
      setOtpError(t("Enter the 6-digit verification code."));
      return;
    }
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
        } else if (error.code === "INVALID_OTP") {
          setError(t("The code is invalid."));
        } else if (error.code === "OTP_EXPIRED") {
          setError(t("The code has expired."));
        } else if (error.code === "TOO_MANY_ATTEMPTS") {
          setError(t("Too many invalid attempts. Request a new code."));
        } else if (error.code === "PASSWORD_TOO_SHORT") {
          setError(t("The password must be at least 8 characters."));
        } else {
          setError(t("The password could not be reset. Please try again."));
        }
        return;
      }
      Alert.alert(
        t("Your password was updated"),
        t("Sign in with your new password."),
      );
      onDone();
    });
  }

  function showUnreachable() {
    setError(
      t("Could not connect. Check your internet connection and try again."),
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
            ? t("Too many attempts. Please wait one minute.")
            : t("The request could not be sent. Please try again."),
        );
        return;
      }
      setOtp("");
      setInfo(t("A new code was sent."));
    });
  }

  return (
    <AuthShell onBack={onBack}>
      <AuthHeading
        title={t("Create a new password")}
        subtitle={t("Enter the code sent to {{email}} and your new password.", {
          email,
        })}
      />

      {error || info ? (
        <View style={styles.messages}>
          <ErrorMsg text={error} />
          <InfoMsg text={info} />
        </View>
      ) : null}

      <View style={styles.fields}>
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

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: resending }}
        onPress={() => void resend()}
        disabled={resending}
        hitSlop={8}
        style={({ pressed }) => [styles.resend, pressed && styles.pressed]}
      >
        <Text style={styles.resendLabel}>
          {resending ? t("Sending code...") : t("Resend code")}
        </Text>
      </Pressable>
    </AuthShell>
  );
}

const resetStyles = (theme: Theme) =>
  StyleSheet.create({
    messages: { marginTop: theme.spacing.lg, gap: theme.spacing.xs },
    fields: {
      marginTop: theme.spacing.xl,
      marginBottom: theme.spacing.md,
      gap: theme.spacing.md,
    },
    resend: {
      minHeight: 48,
      marginTop: theme.spacing.xs,
      alignItems: "center",
      justifyContent: "center",
    },
    resendLabel: { ...theme.type.supporting, color: theme.colors.accent },
    pressed: { opacity: 0.6 },
  });
