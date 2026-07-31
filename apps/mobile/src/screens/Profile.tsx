import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import type {
  MyProfile,
  MySubscription,
  ProfilePhotoResponse,
} from "@opengym/shared";
import { api, uploadBinary } from "../lib/api";
import { Avatar } from "../components/Avatar";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import {
  CameraGlyph,
  ChevronRightGlyph,
  GearGlyph,
  ShieldGlyph,
} from "../components/icons";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import {
  Badge,
  Divider,
  IconButton,
  Plate,
  ScreenHeader,
  ScrollScreen,
  SectionHeading,
  SettingRow,
  Skeleton,
  StatusMessage,
} from "../ui";

const AVATAR_SIZE = 76;

export function Profile({
  fallbackName,
  onOpenSettings,
}: {
  fallbackName: string;
  onOpenSettings: () => void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(profileStyles);
  const locale = dateLocale(i18n.resolvedLanguage);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPermissionDenied, setPhotoPermissionDenied] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  const load = useCallback(async () => {
    const [profileResult, subscriptionResult] = await Promise.allSettled([
      api<MyProfile>("/api/me/profile"),
      api<MySubscription>("/api/me/subscription"),
    ]);

    if (profileResult.status === "fulfilled") {
      setProfile(profileResult.value);
      setLoadError(null);
    } else {
      setLoadError(
        errorMessage(profileResult.reason, t, "Profil bilgisi alınamadı."),
      );
    }

    if (subscriptionResult.status === "fulfilled") {
      setSubscription(subscriptionResult.value);
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

  const profileName = profile?.name ?? fallbackName;
  const profilePhotoUrl = profile?.profilePhotoUrl ?? null;
  const active = subscription?.active === true;
  const formatDate = (value?: string | null) =>
    value
      ? new Date(value).toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  return (
    <ScrollScreen refreshing={refreshing} onRefresh={refresh}>
      <ScreenHeader
        title={t("Profil")}
        trailing={
          <IconButton
            label={t("Ayarlar")}
            onPress={onOpenSettings}
            icon={(color) => <GearGlyph size={21} color={color} />}
          />
        }
      />

      <Plate>
        <View style={styles.identity}>
          {loading ? (
            <>
              <Skeleton
                width={AVATAR_SIZE}
                height={AVATAR_SIZE}
                radius={AVATAR_SIZE / 2}
              />
              <View style={styles.identitySkeleton}>
                <Skeleton width="72%" height={22} />
                <Skeleton width="54%" height={16} />
              </View>
            </>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  profilePhotoUrl ? t("Fotoğrafı değiştir") : t("Fotoğraf ekle")
                }
                accessibilityState={{ disabled: photoBusy }}
                onPress={() => void chooseProfilePhoto()}
                disabled={photoBusy}
                style={({ pressed }) => [
                  styles.avatar,
                  pressed && styles.pressed,
                  photoBusy && styles.disabled,
                ]}
              >
                <Avatar
                  size={AVATAR_SIZE}
                  name={profileName}
                  photoUrl={profilePhotoUrl}
                  locale={locale}
                />
                <View style={styles.avatarBadge}>
                  <CameraGlyph size={14} color={theme.colors.onAccent} />
                </View>
              </Pressable>

              <View style={styles.identityCopy}>
                <Text style={styles.name} numberOfLines={2}>
                  {profileName}
                </Text>
                {profile?.email ? (
                  <Text style={styles.email} numberOfLines={1}>
                    {profile.email}
                  </Text>
                ) : null}
                <View style={styles.photoActions}>
                  <Text style={styles.photoHint}>
                    {photoBusy
                      ? t("İşleniyor…")
                      : profilePhotoUrl
                        ? t("Değiştirmek için fotoğrafa dokun")
                        : t("Fotoğraf eklemek için dokun")}
                  </Text>
                  {profilePhotoUrl && !photoBusy ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={confirmRemoveProfilePhoto}
                      hitSlop={8}
                      style={({ pressed }) => [
                        styles.removeAction,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.removeLabel}>{t("Kaldır")}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </>
          )}
        </View>
      </Plate>

      <View style={styles.messages}>
        <StatusMessage
          text={loadError}
          actionLabel={t("Tekrar dene")}
          onAction={() => void load()}
        />
        <StatusMessage
          text={photoError}
          actionLabel={photoPermissionDenied ? t("Ayarları aç") : undefined}
          onAction={
            photoPermissionDenied
              ? () => void Linking.openSettings()
              : undefined
          }
        />
      </View>

      <View style={styles.section}>
        <SectionHeading
          title={t("Üyelik")}
          trailing={
            loading ? null : (
              <Badge
                label={active ? t("Aktif") : t("Pasif")}
                tone={active ? "success" : "error"}
              />
            )
          }
        />
        <Plate>
          {loading ? (
            <Skeleton height={18} />
          ) : (
            <>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>{t("Başlangıç")}</Text>
                <Text style={styles.factValue}>
                  {formatDate(subscription?.startsAt)}
                </Text>
              </View>
              <Divider />
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>{t("Bitiş")}</Text>
                <Text style={styles.factValue}>
                  {formatDate(subscription?.endsAt)}
                </Text>
              </View>
              {active ? (
                <>
                  <Divider />
                  <View style={styles.factRow}>
                    <Text style={styles.factLabel}>{t("Kalan gün")}</Text>
                    <Text style={styles.factValue}>
                      {subscription?.remainingDays ?? 0}
                    </Text>
                  </View>
                </>
              ) : null}
            </>
          )}
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Hesap")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("İki adımlı doğrulama")}
            subtitle={profile?.twoFactorEnabled ? t("Etkin") : t("Etkin değil")}
          />
          <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
          <SettingRow
            icon={(color) => <GearGlyph size={19} color={color} />}
            title={t("Ayarlar")}
            subtitle={t("Görünüm, dil, bildirimler ve hesap işlemleri")}
            onPress={onOpenSettings}
            trailing={
              <ChevronRightGlyph size={18} color={theme.colors.textTertiary} />
            }
          />
        </Plate>
      </View>
    </ScrollScreen>
  );
}

const profileStyles = (theme: Theme) =>
  StyleSheet.create({
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.45 },

    identity: {
      minHeight: AVATAR_SIZE,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
    },
    identitySkeleton: { flex: 1, gap: theme.spacing.sm },
    avatar: { borderRadius: AVATAR_SIZE / 2 },
    avatarBadge: {
      position: "absolute",
      right: -2,
      bottom: -2,
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: theme.colors.surface,
    },
    identityCopy: { flex: 1, minWidth: 0 },
    name: { ...theme.type.sectionTitle, color: theme.colors.textPrimary },
    email: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    photoActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    photoHint: {
      ...theme.type.label,
      fontSize: 12,
      color: theme.colors.textTertiary,
      flexShrink: 1,
    },
    removeAction: { minHeight: 32, justifyContent: "center" },
    removeLabel: {
      ...theme.type.label,
      fontSize: 12,
      color: theme.colors.error,
    },

    messages: { gap: theme.spacing.xs, marginTop: theme.spacing.sm },
    section: { marginTop: theme.spacing.xl },

    factRow: {
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    factLabel: { ...theme.type.supporting, color: theme.colors.textSecondary },
    factValue: {
      ...theme.type.supporting,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
    },
  });
