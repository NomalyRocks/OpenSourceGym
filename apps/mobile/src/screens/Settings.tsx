import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Linking, StyleSheet, Text, View } from "react-native";
import * as Application from "expo-application";
import type { MyDeletionRequest } from "@opengym/shared";
import { api } from "../lib/api";
import { authClient } from "../lib/auth";
import { errorMessage } from "../i18n/errors";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import type { NotificationCenter } from "../lib/notifications";
import {
  BellGlyph,
  DeviceGlyph,
  LogOutGlyph,
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
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);

  const loadDeletion = useCallback(async () => {
    try {
      setDeletion(await api<MyDeletionRequest>("/api/me/deletion-request"));
    } catch {
      // Silme talebi durumu okunamazsa bölüm varsayılan hâlinde kalır; asıl
      // eylem yine de denenebilir ve hatası ayrıca gösterilir.
    }
  }, []);

  useEffect(() => {
    void loadDeletion();
  }, [loadDeletion]);

  function confirmDeletion() {
    Alert.alert(
      t("Hesabı sil"),
      t(
        "Bu talep personel onayına gönderilir. Onaylanırsa hesabınız ve kişisel verileriniz kalıcı olarak silinir, bu işlem geri alınamaz.",
      ),
      [
        { text: t("Vazgeç"), style: "cancel" },
        {
          text: t("Talep oluştur"),
          style: "destructive",
          onPress: () => void requestDeletion(),
        },
      ],
    );
  }

  async function requestDeletion() {
    setDeletionError(null);
    setDeletionBusy(true);
    try {
      await api("/api/me/deletion-request", { method: "POST" });
      setDeletion(await api<MyDeletionRequest>("/api/me/deletion-request"));
      void center.refresh();
    } catch (error) {
      setDeletionError(
        errorMessage(error, t, "Talep oluşturulamadı. Tekrar deneyin."),
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
        errorMessage(error, t, "Talep iptal edilemedi. Tekrar deneyin."),
      );
    } finally {
      setDeletionBusy(false);
    }
  }

  // Çıkış da ağ isteğidir: sessizce başarısız olursa üye hâlâ oturumda olduğunu
  // fark etmez. Hata görünür olmalı ve buton yeniden denenebilir kalmalı.
  async function signOut() {
    setSignOutError(null);
    setSignOutBusy(true);
    try {
      await authClient.signOut();
    } catch (error) {
      setSignOutError(
        errorMessage(error, t, "Çıkış yapılamadı. Tekrar deneyin."),
      );
    } finally {
      setSignOutBusy(false);
    }
  }

  const themeOptions: ReadonlyArray<SegmentOption<ThemeMode>> = [
    {
      value: "system",
      label: t("Cihaz"),
      icon: (color) => <DeviceGlyph size={16} color={color} />,
    },
    {
      value: "light",
      label: t("Açık"),
      icon: (color) => <SunGlyph size={16} color={color} />,
    },
    {
      value: "dark",
      label: t("Koyu"),
      icon: (color) => <MoonGlyph size={16} color={color} />,
    },
  ];

  const version = Application.nativeApplicationVersion;
  const build = Application.nativeBuildVersion;
  const pendingDeletion = deletion?.status === "pending";

  return (
    <ScrollScreen>
      <ScreenHeader title={t("Ayarlar")} onBack={onBack} />

      <View style={styles.section}>
        <SectionHeading title={t("Görünüm")} />
        <Plate>
          <Text style={styles.sectionHint}>
            {t("Uygulamanın açık mı koyu mu görüneceğini seç.")}
          </Text>
          <View style={styles.control}>
            <Segmented
              options={themeOptions}
              value={mode}
              onChange={setMode}
              accessibilityLabel={t("Tema")}
            />
          </View>
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Dil")} />
        <Plate>
          <Text style={styles.sectionHint}>
            {t("Uygulamada kullanmak istediğin dili seç.")}
          </Text>
          <View style={styles.control}>
            <LanguageSwitcher />
          </View>
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Bildirimler")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <BellGlyph size={19} color={color} />}
            title={t("Üyelik hatırlatmaları")}
            subtitle={t("Üyeliğin bitmeye yaklaştığında uyar.")}
            trailing={
              <Toggle
                value={center.prefs.membership}
                onValueChange={(value) => center.setPref("membership", value)}
                label={t("Üyelik hatırlatmaları")}
              />
            }
          />
          <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("Hesap işlemleri")}
            subtitle={t("Hesap silme talebinin durumu değişince haber ver.")}
            trailing={
              <Toggle
                value={center.prefs.account}
                onValueChange={(value) => center.setPref("account", value)}
                label={t("Hesap işlemleri")}
              />
            }
          />
        </Plate>
        {!center.serverConnected ? (
          <Text style={styles.footnote}>
            {t(
              "Bu uyarılar cihazında üretilir; salon duyuruları için anlık bildirim henüz kullanılmıyor.",
            )}
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Gizlilik ve izinler")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("Uygulama izinleri")}
            subtitle={t(
              "Kamera ve konum izinlerini sistem ayarlarından yönet.",
            )}
            onPress={() => void Linking.openSettings()}
          />
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Oturum")} />
        <StatusMessage text={signOutError} />
        <Button
          title={t("Çıkış yap")}
          variant="secondary"
          busy={signOutBusy}
          onPress={() => void signOut()}
          icon={(color) => <LogOutGlyph size={18} color={color} />}
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Hesap işlemleri")} />
        <Plate tone="error">
          <Text style={styles.dangerHint}>
            {t("Hesap silme talepleri salon personeli tarafından incelenir.")}
          </Text>
          <View style={styles.control}>
            <StatusMessage text={deletionError} />
            {pendingDeletion ? (
              <>
                <StatusMessage
                  tone="warning"
                  text={t("Hesap silme talebiniz personel onayı bekliyor.")}
                />
                <Button
                  title={t("Talebi iptal et")}
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
                    text={t("Önceki silme talebiniz reddedildi.")}
                  />
                ) : null}
                <Button
                  title={t("Hesabımı sil")}
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
