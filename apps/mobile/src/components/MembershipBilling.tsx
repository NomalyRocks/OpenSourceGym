import type { MySubscription } from "@opengym/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { formatMoney } from "../lib/money";
import { tabularNumbers, useThemedStyles, type Theme } from "../theme";

/** Informational only: a balance never changes membership access or actions. */
export function MembershipBilling({
  billing,
  formatDate,
}: {
  billing: MySubscription["billing"];
  formatDate: (value?: string | null) => string;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(billingStyles);
  if (!billing || (!billing.packageName && billing.balanceMinor <= 0)) {
    return null;
  }

  const overdue =
    billing.nextPaymentDue != null &&
    new Date(billing.nextPaymentDue).getTime() < Date.now();

  return (
    <View style={styles.container}>
      {billing.packageName ? (
        <Text style={styles.packageName}>
          {t("Package: {{name}}", { name: billing.packageName })}
        </Text>
      ) : null}
      {billing.balanceMinor > 0 ? (
        <View style={styles.balance}>
          <Text style={styles.amount}>
            {t("Outstanding balance: {{amount}}", {
              amount: formatMoney(
                billing.balanceMinor,
                billing.currency,
                i18n.resolvedLanguage,
              ),
            })}
          </Text>
          {billing.nextPaymentDue ? (
            <Text style={styles.dueDate}>
              {t(
                overdue
                  ? "Payment overdue since {{date}}"
                  : "Payment due {{date}}",
                {
                  date: formatDate(billing.nextPaymentDue),
                },
              )}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const billingStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
    packageName: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
    balance: {
      padding: theme.spacing.sm,
      gap: theme.spacing.xxs,
      borderRadius: theme.radius.tiny,
      backgroundColor: theme.colors.warningSurface,
    },
    amount: {
      ...theme.type.label,
      ...tabularNumbers,
      color: theme.colors.warning,
    },
    dueDate: {
      ...theme.type.supporting,
      ...tabularNumbers,
      color: theme.colors.textSecondary,
    },
  });
