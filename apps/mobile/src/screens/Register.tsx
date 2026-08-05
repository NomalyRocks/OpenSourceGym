import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextInput,
} from "react-native";
import type { LegalConfig } from "@opengym/shared";
import { api } from "../lib/api";
import { authClient } from "../lib/auth";
import { runAuthAction } from "../lib/authAction";
import { useThemedStyles, type Theme } from "../theme";
import {
  AuthFooterLink,
  AuthHeading,
  AuthShell,
  Button,
  Checkbox,
  ErrorMsg,
  Field,
  PasswordField,
} from "../ui";

export function Register({
  onLogin,
  onRegistered,
}: {
  onLogin: () => void;
  onRegistered: (email: string, password: string) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(registerStyles);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dataProcessing, setDataProcessing] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [legal, setLegal] = useState<LegalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<
      Record<"firstName" | "lastName" | "phone" | "email" | "password", string>
    >
  >({});
  const refs = {
    firstName: useRef<TextInput>(null),
    lastName: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    phone: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
  };

  useEffect(() => {
    let cancelled = false;
    api<LegalConfig>("/api/legal")
      .then((config) => {
        if (!cancelled) setLegal(config);
      })
      .catch(() => {
        // Document URLs could not be loaded; checkboxes remain unlinked without blocking registration.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setError(null);
    const required = t("This field is required.");
    const nextErrors: typeof fieldErrors = {};
    if (!firstName.trim()) nextErrors.firstName = required;
    if (!lastName.trim()) nextErrors.lastName = required;
    if (!email.trim()) nextErrors.email = required;
    if (!phone.trim()) nextErrors.phone = required;
    if (!password) nextErrors.password = required;
    else if (password.length < 8) {
      nextErrors.password = t("The password must be at least 8 characters.");
    }
    setFieldErrors(nextErrors);
    const firstInvalid = (
      ["firstName", "lastName", "email", "phone", "password"] as const
    ).find((key) => nextErrors[key]);
    if (firstInvalid) {
      refs[firstInvalid].current?.focus();
      return;
    }
    if (!dataProcessing || !privacy) {
      setError(
        t("You must accept the data processing notice and privacy policy."),
      );
      return;
    }
    await runAuthAction(
      setBusy,
      () =>
        setError(
          t("Could not connect. Check your internet connection and try again."),
        ),
      async () => {
        const { error } = await authClient.signUp.email({
          name: `${firstName} ${lastName}`,
          email,
          password,
          // @ts-expect-error additional fields are defined in the server schema
          firstName,
          lastName,
          phone,
          dataProcessingAccepted: dataProcessing,
          privacyAccepted: privacy,
        });
        if (error) {
          if (error.code === "PHONE_ALREADY_EXISTS") {
            setError(
              t("An account is already registered with this phone number."),
            );
          } else if (error.code === "INVALID_PHONE_NUMBER") {
            setError(t("Enter a valid phone number."));
          } else if (
            error.code === "USER_ALREADY_EXISTS" ||
            error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
          ) {
            setError(t("An account is already registered with this email."));
          } else {
            setError(t("Registration failed."));
          }
          return;
        }
        onRegistered(email, password);
      },
    );
  }

  return (
    <AuthShell
      onBack={onLogin}
      footer={
        <AuthFooterLink
          prompt={t("Already have an account?")}
          actionLabel={t("Sign In")}
          onPress={onLogin}
        />
      }
    >
      <AuthHeading
        title={t("Create account")}
        subtitle={t("Create your membership and enter with QR")}
      />

      {error ? (
        <View style={styles.errorSlot}>
          <ErrorMsg text={error} />
        </View>
      ) : null}

      <View style={styles.fields}>
        <View style={styles.nameRow}>
          <View style={styles.nameCell}>
            <Field
              inputRef={refs.firstName}
              label={t("First name")}
              value={firstName}
              error={fieldErrors.firstName}
              onChangeText={(value) => {
                setFirstName(value);
                setFieldErrors((current) => ({
                  ...current,
                  firstName: undefined,
                }));
              }}
              autoComplete="given-name"
              returnKeyType="next"
              onSubmitEditing={() => refs.lastName.current?.focus()}
            />
          </View>
          <View style={styles.nameCell}>
            <Field
              inputRef={refs.lastName}
              label={t("Last name")}
              value={lastName}
              error={fieldErrors.lastName}
              onChangeText={(value) => {
                setLastName(value);
                setFieldErrors((current) => ({
                  ...current,
                  lastName: undefined,
                }));
              }}
              autoComplete="family-name"
              returnKeyType="next"
              onSubmitEditing={() => refs.email.current?.focus()}
            />
          </View>
        </View>
        <Field
          inputRef={refs.email}
          label={t("Email")}
          value={email}
          error={fieldErrors.email}
          onChangeText={(value) => {
            setEmail(value);
            setFieldErrors((current) => ({ ...current, email: undefined }));
          }}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          returnKeyType="next"
          onSubmitEditing={() => refs.phone.current?.focus()}
        />
        <Field
          inputRef={refs.phone}
          label={t("Phone number")}
          value={phone}
          error={fieldErrors.phone}
          onChangeText={(value) => {
            setPhone(value);
            setFieldErrors((current) => ({ ...current, phone: undefined }));
          }}
          keyboardType="phone-pad"
          autoComplete="tel"
          placeholder="+905xxxxxxxxx"
          returnKeyType="next"
          onSubmitEditing={() => refs.password.current?.focus()}
        />
        <PasswordField
          inputRef={refs.password}
          label={t("Password (min. 8 characters)")}
          value={password}
          error={fieldErrors.password}
          helperText={t("Use at least 8 characters.")}
          onChangeText={(value) => {
            setPassword(value);
            setFieldErrors((current) => ({ ...current, password: undefined }));
          }}
          autoComplete="new-password"
          returnKeyType="done"
        />
      </View>

      <View style={styles.consents}>
        <Checkbox
          checked={dataProcessing}
          onToggle={() => setDataProcessing(!dataProcessing)}
          label={t(
            "I have read the data processing notice and consent to the processing of my personal data.",
          )}
        />
        {legal?.dataProcessingUrl ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() => void Linking.openURL(legal.dataProcessingUrl!)}
            style={styles.consentLink}
          >
            <Text style={styles.consentLinkLabel}>{t("View document")}</Text>
          </Pressable>
        ) : null}
        <Checkbox
          checked={privacy}
          onToggle={() => setPrivacy(!privacy)}
          label={t("I have read and accept the privacy policy.")}
        />
        {legal?.privacyUrl ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() => void Linking.openURL(legal.privacyUrl!)}
            style={styles.consentLink}
          >
            <Text style={styles.consentLinkLabel}>{t("View document")}</Text>
          </Pressable>
        ) : null}
      </View>

      <Button title={t("Sign Up")} onPress={submit} busy={busy} />
    </AuthShell>
  );
}

const registerStyles = (theme: Theme) =>
  StyleSheet.create({
    errorSlot: { marginTop: theme.spacing.lg },
    fields: { marginTop: theme.spacing.xl, gap: theme.spacing.md },
    nameRow: { flexDirection: "row", gap: theme.spacing.sm },
    nameCell: { flex: 1, minWidth: 0 },
    consents: {
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.md,
      gap: theme.spacing.xxs,
    },
    consentLink: {
      marginLeft: 22 + theme.spacing.sm,
      marginTop: -theme.spacing.xxs,
      marginBottom: theme.spacing.xxs,
    },
    consentLinkLabel: {
      ...theme.type.supporting,
      fontWeight: "700",
      color: theme.colors.accent,
    },
  });
