import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text, View } from "react-native";
import * as Application from "expo-application";
import type { MyDeletionRequest } from "@opengym/shared";
import { api } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import type { NotificationCenter } from "../lib/notifications";
import {
  BellGlyph,
  DeviceGlyph,
  MoonGlyph,
  ShieldGlyph,
  SunGlyph,
  TrashGlyph,
} from "../components/icons";
import {
  useTheme,
  useThemedStyles,
  useThemeMode,
  type Theme,
  type ThemeMode,
} from "../theme";
import {
  Button,
  ConfirmSheet,
  Divider,
  Plate,
  ScreenHeader,
  ScrollScreen,
  SectionHeading,
  Segmented,
  SettingRow,
  StatusMessage,
  Toggle,
  type SegmentOption,
} from "../ui";

export function Settings({
  center,
  onBack,
}: {
  center: NotificationCenter;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(settingsStyles);
  const { mode, setMode } = useThemeMode();

  const [deletion, setDeletion] = useState<MyDeletionRequest | null>(null);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [deletionSheet, setDeletionSheet] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);

  const loadDeletion = useCallback(async () => {
    try {
      setDeletion(await api<MyDeletionRequest>("/api/me/deletion-request"));
    } catch {
      // If deletion-request status cannot be read, the section remains in its
      // default state; the action can still be attempted and shows its own error.
    }
  }, []);

  useEffect(() => {
    void loadDeletion();
  }, [loadDeletion]);

  function confirmDeletion() {
    setDeletionError(null);
    setDeletionSheet(true);
  }

  async function requestDeletion() {
    setDeletionError(null);
    setDeletionBusy(true);
    try {
      await api("/api/me/deletion-request", { method: "POST" });
      setDeletion(await api<MyDeletionRequest>("/api/me/deletion-request"));
      void center.refresh();
      setDeletionSheet(false);
    } catch (error) {
      setDeletionError(
        errorMessage(
          error,
          t,
          "The request could not be created. Please try again.",
        ),
      );
    } finally {
      setDeletionBusy(false);
    }
  }

  async function cancelDeletion() {
    setDeletionError(null);
    setDeletionBusy(true);
    try {
      await api("/api/me/deletion-request", { method: "DELETE" });
      setDeletion(await api<MyDeletionRequest>("/api/me/deletion-request"));
      void center.refresh();
    } catch (error) {
      setDeletionError(
        errorMessage(
          error,
          t,
          "The request could not be cancelled. Please try again.",
        ),
      );
    } finally {
      setDeletionBusy(false);
    }
  }

  const themeOptions: ReadonlyArray<SegmentOption<ThemeMode>> = [
    {
      value: "system",
      label: t("System"),
      icon: (color) => <DeviceGlyph size={16} color={color} />,
    },
    {
      value: "light",
      label: t("Light"),
      icon: (color) => <SunGlyph size={16} color={color} />,
    },
    {
      value: "dark",
      label: t("Dark"),
      icon: (color) => <MoonGlyph size={16} color={color} />,
    },
  ];

  const version = Application.nativeApplicationVersion;
  const build = Application.nativeBuildVersion;
  const pendingDeletion = deletion?.status === "pending";

  return (
    <ScrollScreen>
      <ScreenHeader title={t("Settings")} onBack={onBack} />

      <View style={styles.section}>
        <SectionHeading title={t("Appearance")} />
        <Plate>
          <Text style={styles.sectionHint}>
            {t("Choose whether the app looks light or dark.")}
          </Text>
          <View style={styles.control}>
            <Segmented
              options={themeOptions}
              value={mode}
              onChange={setMode}
              accessibilityLabel={t("Theme")}
            />
          </View>
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Language")} />
        <Plate>
          <Text style={styles.sectionHint}>
            {t("Choose the language you want to use in the app.")}
          </Text>
          <View style={styles.control}>
            <LanguageSwitcher />
          </View>
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Notifications")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <BellGlyph size={19} color={color} />}
            title={t("Membership reminders")}
            subtitle={t("Warn me when my membership is close to expiring.")}
            trailing={
              <Toggle
                value={center.prefs.membership}
                onValueChange={(value) => center.setPref("membership", value)}
                label={t("Membership reminders")}
              />
            }
          />
          <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("Account actions")}
            subtitle={t("Notify me when my deletion request changes status.")}
            trailing={
              <Toggle
                value={center.prefs.account}
                onValueChange={(value) => center.setPref("account", value)}
                label={t("Account actions")}
              />
            }
          />
        </Plate>
        {!center.serverConnected ? (
          <Text style={styles.footnote}>
            {t(
              "These alerts are generated on your device; push notifications for gym announcements are not in use yet.",
            )}
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Privacy and permissions")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("App permissions")}
            subtitle={t(
              "Manage camera and location permissions in system settings.",
            )}
            onPress={() => void Linking.openSettings()}
          />
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Account actions")} />
        <Plate tone="error">
          <Text style={styles.dangerHint}>
            {t("Account deletion requests are reviewed by gym staff.")}
          </Text>
          <View style={styles.control}>
            <StatusMessage text={deletionSheet ? null : deletionError} />
            {pendingDeletion ? (
              <>
                <StatusMessage
                  tone="warning"
                  text={t(
                    "Your account deletion request is awaiting staff approval.",
                  )}
                />
                <Button
                  title={t("Cancel request")}
                  variant="secondary"
                  busy={deletionBusy}
                  onPress={() => void cancelDeletion()}
                />
              </>
            ) : (
              <>
                {deletion?.status === "rejected" ? (
                  <StatusMessage
                    tone="neutral"
                    text={t("Your previous deletion request was rejected.")}
                  />
                ) : null}
                <Button
                  title={t("Delete my account")}
                  variant="danger"
                  busy={deletionBusy}
                  onPress={confirmDeletion}
                  icon={(color) => <TrashGlyph size={18} color={color} />}
                />
              </>
            )}
          </View>
        </Plate>
      </View>

      <Text style={styles.version}>
        {version
          ? t("OpenGym {{version}} ({{build}})", {
              version,
              build: build ?? "—",
            })
          : "OpenGym"}
      </Text>

      <ConfirmSheet
        visible={deletionSheet}
        title={t("Delete account")}
        body={
          <Text style={styles.dangerHint}>
            {t(
              "This request will be sent for staff approval. If approved, your account and personal data will be permanently deleted and cannot be restored.",
            )}
          </Text>
        }
        confirmLabel={t("Create request")}
        confirmTone="danger"
        cancelLabel={t("Cancel")}
        busy={deletionBusy}
        error={deletionError}
        onConfirm={() => void requestDeletion()}
        onCancel={() => setDeletionSheet(false)}
      />
    </ScrollScreen>
  );
}

const settingsStyles = (theme: Theme) =>
  StyleSheet.create({
    section: { marginTop: theme.spacing.xl },
    sectionHint: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
    },
    control: { marginTop: theme.spacing.md, gap: theme.spacing.sm },
    footnote: {
      ...theme.type.supporting,
      fontSize: 13,
      color: theme.colors.textTertiary,
      marginTop: theme.spacing.sm,
    },
    dangerHint: { ...theme.type.supporting, color: theme.colors.textSecondary },
    version: {
      ...theme.type.label,
      color: theme.colors.textTertiary,
      textAlign: "center",
      marginTop: theme.spacing.xxl,
    },
  });
