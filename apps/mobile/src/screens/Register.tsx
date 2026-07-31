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
  const [kvkk, setKvkk] = useState(false);
  const [privacy, setPrivacy] = useState(false);
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

  async function submit() {
    setError(null);
    const required = t("Bu alan zorunludur.");
    const nextErrors: typeof fieldErrors = {};
    if (!firstName.trim()) nextErrors.firstName = required;
    if (!lastName.trim()) nextErrors.lastName = required;
    if (!email.trim()) nextErrors.email = required;
    if (!phone.trim()) nextErrors.phone = required;
    if (!password) nextErrors.password = required;
    else if (password.length < 8) {
      nextErrors.password = t("Şifre en az 8 karakter olmalı.");
    }
    setFieldErrors(nextErrors);
    const firstInvalid = (
      ["firstName", "lastName", "email", "phone", "password"] as const
    ).find((key) => nextErrors[key]);
    if (firstInvalid) {
      refs[firstInvalid].current?.focus();
      return;
    }
    if (!kvkk || !privacy) {
      setError(
        t("KVKK aydınlatma metni ve gizlilik sözleşmesi onayları zorunludur."),
      );
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
        const { error } = await authClient.signUp.email({
          name: `${firstName} ${lastName}`,
          email,
          password,
          // @ts-expect-error ek alanlar sunucu şemasında tanımlı
          firstName,
          lastName,
          phone,
          kvkkAccepted: kvkk,
          privacyAccepted: privacy,
        });
        if (error) {
          if (error.code === "PHONE_ALREADY_EXISTS") {
            setError(t("Bu telefon numarası ile kayıtlı hesap var."));
          } else if (error.code === "INVALID_PHONE_NUMBER") {
            setError(t("Geçerli bir telefon numarası girin."));
          } else if (
            error.code === "USER_ALREADY_EXISTS" ||
            error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
          ) {
            setError(t("Bu e-posta ile kayıtlı hesap var."));
          } else {
            setError(t("Kayıt başarısız."));
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
          prompt={t("Zaten hesabın var mı?")}
          actionLabel={t("Giriş Yap")}
          onPress={onLogin}
        />
      }
    >
      <AuthHeading
        title={t("Hesap oluştur")}
        subtitle={t("Üyeliğini oluştur ve QR ile giriş yap")}
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
              label={t("İsim")}
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
              label={t("Soyisim")}
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
          label={t("E-posta")}
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
          label={t("Telefon Numarası")}
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
          label={t("Şifre (min. 8 karakter)")}
          value={password}
          error={fieldErrors.password}
          helperText={t("En az 8 karakter kullanın.")}
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
          checked={kvkk}
          onToggle={() => setKvkk(!kvkk)}
          label={t(
            "KVKK aydınlatma metnini okudum, kişisel verilerimin işlenmesini onaylıyorum.",
          )}
        />
        <Checkbox
          checked={privacy}
          onToggle={() => setPrivacy(!privacy)}
          label={t("Gizlilik sözleşmesini okudum ve kabul ediyorum.")}
        />
      </View>

      <Button title={t("Kayıt Ol")} onPress={submit} busy={busy} />
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
  });
