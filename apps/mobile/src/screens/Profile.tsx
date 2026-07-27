import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import type {
  MyDeletionRequest,
  MyProfile,
  ProfilePhotoResponse,
} from "@opengym/shared";
import { api, uploadBinary } from "../lib/api";
import { authClient } from "../lib/auth";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import { colors, radius, spacing, type } from "../theme";
import { Button, Skeleton, StatusMessage } from "../ui";

const AVATAR_SIZE = 88;

export function Profile({ fallbackName }: { fallbackName: string }) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const locale = dateLocale(i18n.resolvedLanguage);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [deletion, setDeletion] = useState<MyDeletionRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPermissionDenied, setPhotoPermissionDenied] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoLoadFailed, setPhotoLoadFailed] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);

  const load = useCallback(async () => {
    const [profileResult, deletionResult] = await Promise.allSettled([
      api<MyProfile>("/api/me/profile"),
      api<MyDeletionRequest>("/api/me/deletion-request"),
    ]);

    if (profileResult.status === "fulfilled") {
      setProfile(profileResult.value);
      setPhotoLoadFailed(false);
      setLoadError(null);
    } else {
      setLoadError(
        errorMessage(profileResult.reason, t, "Profil bilgisi alınamadı."),
      );
    }

    if (deletionResult.status === "fulfilled") {
      setDeletion(deletionResult.value);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function chooseProfilePhoto() {
    setPhotoError(null);
    setPhotoPermissionDenied(false);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPhotoPermissionDenied(true);
      setPhotoError(t("Fotoğraf seçmek için galeri izni vermelisiniz."));
      return;
    }

    const selected = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      allowsMultipleSelection: false,
    });
    if (selected.canceled || !selected.assets[0]) return;

    setPhotoBusy(true);
    try {
      // Native modülü yalnızca fotoğraf işlenirken yükle. Böylece modülü henüz
      // içermeyen eski development client'lar uygulama açılışında çökmez.
      const { ImageManipulator, SaveFormat } =
        await import("expo-image-manipulator");
      const context = ImageManipulator.manipulate(selected.assets[0].uri);
      context.resize({ width: 1024 });
      const rendered = await context.renderAsync();
      const normalized = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.88,
      });
      const response = await uploadBinary<ProfilePhotoResponse>(
        "/api/me/profile-photo",
        normalized.uri,
        "image/jpeg",
      );
      setProfile((current) =>
        current
          ? { ...current, profilePhotoUrl: response.profilePhotoUrl }
          : current,
      );
      setPhotoLoadFailed(false);
    } catch (error) {
      setPhotoError(
        errorMessage(error, t, "Profil fotoğrafı yüklenemedi. Tekrar deneyin."),
      );
    } finally {
      setPhotoBusy(false);
    }
  }

  function confirmRemoveProfilePhoto() {
    Alert.alert(
      t("Fotoğrafı kaldır"),
      t("Profil fotoğrafınız kaldırılsın mı?"),
      [
        { text: t("Vazgeç"), style: "cancel" },
        {
          text: t("Kaldır"),
          style: "destructive",
          onPress: () => void removeProfilePhoto(),
        },
      ],
    );
  }

  async function removeProfilePhoto() {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await api<ProfilePhotoResponse>("/api/me/profile-photo", {
        method: "DELETE",
      });
      setProfile((current) =>
        current ? { ...current, profilePhotoUrl: null } : current,
      );
      setPhotoLoadFailed(false);
    } catch (error) {
      setPhotoError(
        errorMessage(
          error,
          t,
          "Profil fotoğrafı kaldırılamadı. Tekrar deneyin.",
        ),
      );
    } finally {
      setPhotoBusy(false);
    }
  }

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
    } catch (error) {
      setDeletionError(
        errorMessage(error, t, "Talep iptal edilemedi. Tekrar deneyin."),
      );
    } finally {
      setDeletionBusy(false);
    }
  }

  const profileName = profile?.name ?? fallbackName;
  const initials = profileName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase(locale) ?? "")
    .join("");
  const profilePhotoUrl = profile?.profilePhotoUrl ?? null;

  return (
    <ScrollView
      style={profileStyles.screen}
      contentContainerStyle={[
        profileStyles.content,
        { paddingTop: insets.top + spacing.lg },
      ]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.textPrimary}
          colors={[colors.textPrimary]}
          progressBackgroundColor={colors.surfaceRaised}
        />
      }
    >
      <Text accessibilityRole="header" style={profileStyles.screenTitle}>
        {t("Profil")}
      </Text>
      <Text style={profileStyles.screenSubtitle}>
        {t("Hesabını ve uygulama tercihlerini yönet.")}
      </Text>

      <View style={profileStyles.identity}>
        {loading ? (
          <>
            <Skeleton width={AVATAR_SIZE} height={AVATAR_SIZE} radius={44} />
            <View style={{ flex: 1, gap: spacing.sm }}>
              <Skeleton width="70%" height={24} />
              <Skeleton width="52%" height={18} />
            </View>
          </>
        ) : (
          <>
            <View style={profileStyles.avatar}>
              {profilePhotoUrl && !photoLoadFailed ? (
                <Image
                  source={{ uri: profilePhotoUrl }}
                  style={profileStyles.avatarImage}
                  accessibilityLabel={t("{{name}} profil fotoğrafı", {
                    name: profileName,
                  })}
                  onError={() => setPhotoLoadFailed(true)}
                />
              ) : (
                <Text style={profileStyles.initials}>{initials || "O"}</Text>
              )}
            </View>
            <View style={profileStyles.identityCopy}>
              <Text style={profileStyles.name}>{profileName}</Text>
              {profile?.email ? (
                <Text style={profileStyles.email}>{profile.email}</Text>
              ) : null}
              <View style={profileStyles.photoActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void chooseProfilePhoto()}
                  disabled={photoBusy}
                  style={({ pressed }) => [
                    profileStyles.textAction,
                    pressed && profileStyles.pressed,
                    photoBusy && profileStyles.disabled,
                  ]}
                >
                  <Text style={profileStyles.textActionLabel}>
                    {photoBusy
                      ? t("İşleniyor…")
                      : profilePhotoUrl
                        ? t("Fotoğrafı değiştir")
                        : t("Fotoğraf ekle")}
                  </Text>
                </Pressable>
                {profilePhotoUrl ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={confirmRemoveProfilePhoto}
                    disabled={photoBusy}
                    style={({ pressed }) => [
                      profileStyles.textAction,
                      pressed && profileStyles.pressed,
                    ]}
                  >
                    <Text style={profileStyles.removeAction}>
                      {t("Kaldır")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </>
        )}
      </View>

      <StatusMessage
        text={loadError}
        actionLabel={t("Tekrar dene")}
        onAction={() => void load()}
      />
      <StatusMessage
        text={photoError}
        actionLabel={photoPermissionDenied ? t("Ayarları aç") : undefined}
        onAction={
          photoPermissionDenied ? () => void Linking.openSettings() : undefined
        }
      />

      <View style={profileStyles.section}>
        <Text style={profileStyles.sectionTitle}>{t("Dil")}</Text>
        <Text style={profileStyles.sectionHint}>
          {t("Uygulamada kullanmak istediğin dili seç.")}
        </Text>
        <View style={{ marginTop: spacing.md }}>
          <LanguageSwitcher />
        </View>
      </View>

      <View style={profileStyles.section}>
        <Text style={profileStyles.sectionTitle}>{t("Oturum")}</Text>
        <View style={{ marginTop: spacing.sm }}>
          <Button
            title={t("Çıkış yap")}
            variant="secondary"
            onPress={() => void authClient.signOut()}
          />
        </View>
      </View>

      <View style={profileStyles.dangerSection}>
        <Text style={profileStyles.dangerTitle}>{t("Hesap işlemleri")}</Text>
        <Text style={profileStyles.sectionHint}>
          {t("Hesap silme talepleri salon personeli tarafından incelenir.")}
        </Text>
        <View style={{ marginTop: spacing.md }}>
          <StatusMessage text={deletionError} />
          {deletion?.status === "pending" ? (
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
              />
            </>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const profileStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.xxl,
  },
  screenTitle: { ...type.screenTitle, color: colors.textPrimary },
  screenSubtitle: {
    ...type.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  identity: {
    minHeight: AVATAR_SIZE,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: "100%", height: "100%" },
  initials: { fontSize: 28, fontWeight: "700", color: colors.textPrimary },
  identityCopy: { flex: 1 },
  name: { ...type.sectionTitle, color: colors.textPrimary },
  email: { ...type.supporting, color: colors.textSecondary, marginTop: 2 },
  photoActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  textAction: { minHeight: 44, justifyContent: "center" },
  textActionLabel: { ...type.label, color: colors.textPrimary },
  removeAction: { ...type.label, color: colors.textSecondary },
  section: {
    paddingVertical: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outline,
  },
  sectionTitle: { ...type.title, color: colors.textPrimary },
  sectionHint: {
    ...type.supporting,
    color: colors.textSecondary,
    marginTop: spacing.xxs,
  },
  dangerSection: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.errorSurface,
  },
  dangerTitle: { ...type.title, color: colors.error },
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.46 },
});
