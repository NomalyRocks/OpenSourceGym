import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { OtpInput } from "../components/OtpInput";
import { useThemedStyles, type Theme } from "../theme";
import { AuthHeading, AuthShell, Button, ErrorMsg, InfoMsg } from "../ui";

/**
 * First step of the password reset: the code is checked on its own so the new
 * password is chosen on a screen of its own. The check does not consume the
 * code, so the same one is replayed on the next screen.
 */
export function VerifyResetCode({
  email,
  onVerified,
  onBack,
}: {
  email: string;
  onVerified: (otp: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(verifyResetStyles);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  function showUnreachable() {
    setError(
      t("Could not connect. Check your internet connection and try again."),
    );
  }

  async function submit() {
    setError(null);
    setInfo(null);
    setOtpError(null);
    if (otp.length !== 6) {
      setOtpError(t("Enter the 6-digit verification code."));
      return;
    }
    await runAuthAction(setBusy, showUnreachable, async () => {
      const { error } = await authClient.emailOtp.checkVerificationOtp({
        email,
        otp,
        type: "forget-password",
      });
      if (error) {
        if (error.status === 429) {
          setError(t("Too many attempts. Please wait one minute."));
        } else if (error.code === "OTP_EXPIRED") {
          setError(t("The code has expired."));
        } else if (error.code === "TOO_MANY_ATTEMPTS") {
          setError(t("Too many invalid attempts. Request a new code."));
        } else {
          // USER_NOT_FOUND is folded in here on purpose: a distinct message
          // would tell an attacker which addresses have an account.
          setError(t("The code is invalid."));
        }
        return;
      }
      onVerified(otp);
    });
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
        title={t("Verification Code")}
        subtitle={t("Enter the 6-digit code sent to {{email}}", { email })}
      />

      {error || info ? (
        <View style={styles.messages}>
          <ErrorMsg text={error} />
          <InfoMsg text={info} />
        </View>
      ) : null}

      <View style={styles.otp}>
        <OtpInput
          value={otp}
          error={otpError}
          autoFocus
          onChangeText={(value) => {
            setOtp(value);
            if (otpError) setOtpError(null);
          }}
        />
      </View>

      <Button
        title={t("Continue")}
        onPress={submit}
        busy={busy}
        disabled={otp.length !== 6}
      />

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

const verifyResetStyles = (theme: Theme) =>
  StyleSheet.create({
    messages: { marginTop: theme.spacing.lg, gap: theme.spacing.xs },
    otp: { marginTop: theme.spacing.xl, marginBottom: theme.spacing.lg },
    resend: {
      minHeight: 48,
      marginTop: theme.spacing.xs,
      alignItems: "center",
      justifyContent: "center",
    },
    resendLabel: { ...theme.type.supporting, color: theme.colors.accent },
    pressed: { opacity: 0.6 },
  });
