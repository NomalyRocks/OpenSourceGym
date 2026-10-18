import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { MemberBan } from "@opengym/shared";
import { authClient } from "../lib/auth";
import { CloseGlyph, LogOutGlyph } from "../components/icons";
import { useTheme, useThemedStyles, type Theme } from "../theme";
import { Button, Screen, StatusMessage } from "../ui";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

/**
 * Replaces the whole signed-in shell while the member is banned. The only
 * action is signing out; the session is kept so an unban takes effect when the
 * app returns to the foreground.
 */
export function Banned({ ban }: { ban: MemberBan }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(bannedStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bannedOn = new Date(ban.bannedAt).toLocaleDateString(
    dateLocale(i18n.resolvedLanguage),
    { day: "numeric", month: "long", year: "numeric" },
  );

  async function signOut() {
    setError(null);
    setBusy(true);
    try {
      // better-auth reports failure through `error` instead of throwing.
      const { error: signOutError } = await authClient.signOut();
      if (signOutError) {
        setError(
          errorMessage(
            signOutError,
            t,
            "Could not sign out. Please try again.",
          ),
        );
      }
    } catch (caught) {
      setError(
        errorMessage(caught, t, "Could not sign out. Please try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen style={styles.screen}>
      <View style={styles.body}>
        <View style={styles.icon}>
          <CloseGlyph size={56} color={theme.colors.error} />
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {t("You are banned")}
        </Text>
        <Text style={styles.reason}>
          {t("Reason: {{reason}}", { reason: ban.reason })}
        </Text>
        <Text style={styles.date}>
          {t("Banned on {{date}}", { date: bannedOn })}
        </Text>
        <Text style={styles.contact}>
          {t("Please contact the gym reception for more information.")}
        </Text>
      </View>

      <StatusMessage text={error} />
      <Button
        title={t("Sign out")}
        variant="secondary"
        busy={busy}
        onPress={() => void signOut()}
        icon={(color) => <LogOutGlyph size={18} color={color} />}
      />
    </Screen>
  );
}

const bannedStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { justifyContent: "center" },
    body: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.md,
    },
    icon: {
      width: 112,
      height: 112,
      borderRadius: 56,
      backgroundColor: theme.colors.errorSurface,
      borderWidth: 3,
      borderColor: theme.colors.error,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      ...theme.type.screenTitle,
      color: theme.colors.error,
      textAlign: "center",
      marginTop: theme.spacing.xl,
    },
    reason: {
      ...theme.type.body,
      color: theme.colors.textPrimary,
      textAlign: "center",
      marginTop: theme.spacing.md,
    },
    date: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.xs,
    },
    contact: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.lg,
    },
  });
