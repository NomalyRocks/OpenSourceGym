import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import type {
  MyBodyMetrics,
  MyProfile,
  MySubscription,
  ProfilePhotoResponse,
} from "@opengym/shared";
import { api, uploadBinary } from "../lib/api";
import {
  CALORIE_LIMITS,
  formatEditable,
  parseLocalizedNumber,
} from "../lib/calorieCalculator";
import {
  loadCalorieCalculatorState,
  saveCalorieCalculatorState,
} from "../lib/calorieCalculatorStorage";
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
  Button,
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
  const language = i18n.resolvedLanguage;
  const [bodyAge, setBodyAge] = useState("");
  const [bodyHeight, setBodyHeight] = useState("");
  const [bodyWeight, setBodyWeight] = useState("");
  const [bodyMetricsHydrated, setBodyMetricsHydrated] = useState(false);
  const [bodyMetricsSaving, setBodyMetricsSaving] = useState(false);
  const [bodyMetricsSaved, setBodyMetricsSaved] = useState(false);
  const [bodyMetricsError, setBodyMetricsError] = useState<string | null>(null);

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
        errorMessage(
          profileResult.reason,
          t,
          "Profile data could not be loaded.",
        ),
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

  // Populate once from server values when the profile first loads; later
  // refreshes do not overwrite the user's in-progress edits.
  useEffect(() => {
    if (bodyMetricsHydrated || !profile) return;
    if (typeof profile.age === "number") setBodyAge(String(profile.age));
    if (typeof profile.heightCm === "number") {
      setBodyHeight(formatEditable(profile.heightCm, language));
    }
    if (typeof profile.weightKg === "number") {
      setBodyWeight(formatEditable(profile.weightKg, language));
    }
    setBodyMetricsHydrated(true);
  }, [profile, bodyMetricsHydrated, language]);

  async function saveBodyMetrics() {
    setBodyMetricsError(null);
    setBodyMetricsSaved(false);

    const ageValue = bodyAge.trim() ? parseLocalizedNumber(bodyAge) : null;
    const heightValue = bodyHeight.trim()
      ? parseLocalizedNumber(bodyHeight)
      : null;
    const weightValue = bodyWeight.trim()
      ? parseLocalizedNumber(bodyWeight)
      : null;

    if (
      bodyAge.trim() &&
      (ageValue == null ||
        !Number.isInteger(ageValue) ||
        ageValue < CALORIE_LIMITS.age.min ||
        ageValue > CALORIE_LIMITS.age.max)
    ) {
      setBodyMetricsError(t("Enter a whole-number age between 18 and 80."));
      return;
    }
    if (
      bodyHeight.trim() &&
      (heightValue == null ||
        heightValue < CALORIE_LIMITS.heightCm.min ||
        heightValue > CALORIE_LIMITS.heightCm.max)
    ) {
      setBodyMetricsError(t("Enter a valid height in the 120–230 cm range."));
      return;
    }
    if (
      bodyWeight.trim() &&
      (weightValue == null ||
        weightValue < CALORIE_LIMITS.weightKg.min ||
        weightValue > CALORIE_LIMITS.weightKg.max)
    ) {
      setBodyMetricsError(t("Enter a valid weight in the 35–300 kg range."));
      return;
    }

    const update: { age?: number; heightCm?: number; weightKg?: number } = {};
    if (ageValue != null) update.age = ageValue;
    if (heightValue != null) update.heightCm = heightValue;
    if (weightValue != null) update.weightKg = weightValue;
    if (Object.keys(update).length === 0) {
      setBodyMetricsError(t("Fill in at least one field to save."));
      return;
    }

    setBodyMetricsSaving(true);
    try {
      // Protected endpoint: `api()` throws ApiError outside 2xx, so a failed
      // write is not displayed as "Saved."
      const saved = await api<MyBodyMetrics>("/api/me/body-metrics", {
        method: "PATCH",
        body: update,
      });

      // Calculator cache uses a member-specific key; if the profile was not
      // loaded, there is no cache to update either.
      if (profile) {
        const cached = await loadCalorieCalculatorState(profile.id);
        if (cached) {
          await saveCalorieCalculatorState(profile.id, {
            ...cached,
            ...update,
          });
        }
      }

      setProfile((current) => (current ? { ...current, ...saved } : current));
      setBodyMetricsSaved(true);
    } catch (error) {
      setBodyMetricsError(
        errorMessage(error, t, "Could not save. Please try again."),
      );
    } finally {
      setBodyMetricsSaving(false);
    }
  }

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
      setPhotoError(t("Grant gallery permission to select a photo."));
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
      // Load the native module only while processing a photo. This prevents
      // older development clients without the module from crashing at startup.
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
        errorMessage(
          error,
          t,
          "The profile photo could not be uploaded. Please try again.",
        ),
      );
    } finally {
      setPhotoBusy(false);
    }
  }

  function confirmRemoveProfilePhoto() {
    Alert.alert(t("Remove photo"), t("Remove your profile photo?"), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Remove"),
        style: "destructive",
        onPress: () => void removeProfilePhoto(),
      },
    ]);
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
          "The profile photo could not be removed. Please try again.",
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
        title={t("Profile")}
        trailing={
          <IconButton
            label={t("Settings")}
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
                  profilePhotoUrl ? t("Change photo") : t("Add photo")
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
                      ? t("Processing…")
                      : profilePhotoUrl
                        ? t("Tap the photo to change it")
                        : t("Tap to add a photo")}
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
                      <Text style={styles.removeLabel}>{t("Remove")}</Text>
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
          actionLabel={t("Try again")}
          onAction={() => void load()}
        />
        <StatusMessage
          text={photoError}
          actionLabel={photoPermissionDenied ? t("Open settings") : undefined}
          onAction={
            photoPermissionDenied
              ? () => void Linking.openSettings()
              : undefined
          }
        />
      </View>

      <View style={styles.section}>
        <SectionHeading
          title={t("Membership")}
          trailing={
            loading ? null : (
              <Badge
                label={active ? t("Active") : t("Inactive")}
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
                <Text style={styles.factLabel}>{t("Start")}</Text>
                <Text style={styles.factValue}>
                  {formatDate(subscription?.startsAt)}
                </Text>
              </View>
              <Divider />
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>{t("End")}</Text>
                <Text style={styles.factValue}>
                  {formatDate(subscription?.endsAt)}
                </Text>
              </View>
              {active ? (
                <>
                  <Divider />
                  <View style={styles.factRow}>
                    <Text style={styles.factLabel}>{t("Days left")}</Text>
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
        <SectionHeading title={t("Body info")} />
        <Plate>
          <Text style={styles.metricsHint}>
            {t(
              "Used to auto-fill the calorie calculator; a field you leave empty is not changed.",
            )}
          </Text>
          <View style={styles.metricRow}>
            <Text style={styles.factLabel}>{t("Age")}</Text>
            <TextInput
              value={bodyAge}
              onChangeText={setBodyAge}
              accessibilityLabel={t("Age")}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={3}
              placeholder="—"
              placeholderTextColor={theme.colors.textDisabled}
              selectionColor={theme.colors.accent}
              style={styles.metricInput}
            />
          </View>
          <Divider />
          <View style={styles.metricRow}>
            <Text style={styles.factLabel}>{t("Height (cm)")}</Text>
            <TextInput
              value={bodyHeight}
              onChangeText={setBodyHeight}
              accessibilityLabel={t("Height")}
              keyboardType="decimal-pad"
              inputMode="decimal"
              maxLength={6}
              placeholder="—"
              placeholderTextColor={theme.colors.textDisabled}
              selectionColor={theme.colors.accent}
              style={styles.metricInput}
            />
          </View>
          <Divider />
          <View style={styles.metricRow}>
            <Text style={styles.factLabel}>{t("Weight (kg)")}</Text>
            <TextInput
              value={bodyWeight}
              onChangeText={setBodyWeight}
              accessibilityLabel={t("Weight")}
              keyboardType="decimal-pad"
              inputMode="decimal"
              maxLength={6}
              placeholder="—"
              placeholderTextColor={theme.colors.textDisabled}
              selectionColor={theme.colors.accent}
              style={styles.metricInput}
            />
          </View>

          {bodyMetricsError ? (
            <StatusMessage
              text={bodyMetricsError}
              style={styles.metricsMessage}
            />
          ) : bodyMetricsSaved ? (
            <StatusMessage
              tone="success"
              text={t("Saved.")}
              style={styles.metricsMessage}
            />
          ) : null}

          <Button
            title={bodyMetricsSaving ? t("Saving…") : t("Save")}
            variant="secondary"
            onPress={() => void saveBodyMetrics()}
            disabled={bodyMetricsSaving}
            style={styles.metricsSaveButton}
          />
        </Plate>
      </View>

      <View style={styles.section}>
        <SectionHeading title={t("Account")} />
        <Plate padded={false}>
          <SettingRow
            icon={(color) => <ShieldGlyph size={19} color={color} />}
            title={t("Two-factor authentication")}
            subtitle={profile?.twoFactorEnabled ? t("On") : t("Off")}
          />
          <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
          <SettingRow
            icon={(color) => <GearGlyph size={19} color={color} />}
            title={t("Settings")}
            subtitle={t(
              "Appearance, language, notifications and account actions",
            )}
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

    metricsHint: {
      ...theme.type.supporting,
      color: theme.colors.textTertiary,
      marginBottom: theme.spacing.sm,
    },
    metricRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    metricInput: {
      ...theme.type.supporting,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
      textAlign: "right",
      minWidth: 90,
      paddingVertical: 6,
    },
    metricsMessage: { marginTop: theme.spacing.sm },
    metricsSaveButton: { marginTop: theme.spacing.md },
  });
