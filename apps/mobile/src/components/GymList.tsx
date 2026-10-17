import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { GymRef } from "@opengym/shared";
import { useThemedStyles, type Theme } from "../theme";
import { Badge } from "../ui";

/** Gyms a membership allows; deactivated gyms carry an "Inactive" badge. */
export function GymList({ gyms }: { gyms: GymRef[] }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(gymListStyles);
  return (
    <View style={styles.list}>
      {gyms.map((gym) => (
        <View key={gym.id} style={styles.row}>
          <Text
            style={[styles.name, !gym.active && styles.nameInactive]}
            numberOfLines={1}
          >
            {gym.name}
          </Text>
          {gym.active ? null : <Badge label={t("Inactive")} tone="neutral" />}
        </View>
      ))}
    </View>
  );
}

const gymListStyles = (theme: Theme) =>
  StyleSheet.create({
    list: { gap: theme.spacing.xxs, marginTop: 2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    name: {
      ...theme.type.supporting,
      color: theme.colors.textPrimary,
      flex: 1,
    },
    nameInactive: { color: theme.colors.textTertiary },
  });
