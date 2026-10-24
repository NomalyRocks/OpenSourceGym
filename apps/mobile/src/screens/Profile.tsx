import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
import { useFreezeActions } from "../lib/useFreezeActions";
import { useSignOut } from "../lib/useSignOut";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import {
  CameraGlyph,
  ClockGlyph,
  ChevronRightGlyph,
  GearGlyph,
  LogOutGlyph,
  ShieldGlyph,
} from "../components/icons";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  type Theme,
} from "../theme";
import {
  Button,
  ConfirmSheet,
  Divider,
  IconButton,
  Plate,
  ScreenHeader,
  ScrollScreen,
  SectionHeading,
  SettingRow,
  SheetFacts,
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

  const freezeActions = useFreezeActions({
    allowance: subscription?.freezeAllowance ?? null,
    onChanged: () => load(),
  });
  const signOutAction = useSignOut();

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [removePhotoOpen, setRemovePhotoOpen] = useState(false);

  function openSignOut() {
    signOutAction.clearError();
    setSignOutOpen(true);
  }

  async function confirmSignOut() {
    // On success the session ends and the whole shell unmounts.
    const ended = await signOutAction.signOut();
    if (!ended) return;
    setSignOutOpen(false);
  }

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
      // The fallback message hides client-side failures (native module,
      // network); surface the real cause in the Metro log during development.
      if (__DEV__) console.warn("Profile photo upload failed:", error);
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
    setPhotoError(null);
    setRemovePhotoOpen(true);
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
      setRemovePhotoOpen(false);
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
  const freeze = subscription?.freeze ?? null;
  // An older API may omit the allowance: then no freeze row is shown.
  const freezeAllowance = subscription?.freezeAllowance ?? null;
  const noFreezesLeft =
    active &&
    freezeAllowance != null &&
    freezeAllowance.maxPerYear > 0 &&
    freezeAllowance.usedInLastYear >= freezeAllowance.maxPerYear;
  const showFreezeRow =
    freeze != null || freezeAllowance?.canFreeze === true || noFreezesLeft;

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
          {showFreezeRow ? (
            <>
              <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
              <SettingRow
                icon={(color) => <ClockGlyph size={19} color={color} />}
                title={freeze ? t("Resume membership") : t("Freeze membership")}
                subtitle={
                  noFreezesLeft && !freeze
                    ? t("No freezes left this year.")
                    : freezeAllowance
                      ? t("{{used}} of {{max}} freezes used this year.", {
                          used: freezeAllowance.usedInLastYear,
                          max: freezeAllowance.maxPerYear,
                        })
                      : undefined
                }
                disabled={
                  freezeActions.busy || (noFreezesLeft && freeze == null)
                }
                onPress={
                  freeze ? freezeActions.openResume : freezeActions.openFreeze
                }
              />
            </>
          ) : null}
          <Divider inset={theme.spacing.md + 34 + theme.spacing.sm} />
          <SettingRow
            icon={(color) => <LogOutGlyph size={19} color={color} />}
            title={t("Sign out")}
            tone="danger"
            disabled={signOutAction.busy}
            onPress={openSignOut}
          />
        </Plate>
        <StatusMessage
          text={freezeActions.error}
          style={styles.accountMessage}
        />
        <StatusMessage
          text={signOutAction.error}
          style={styles.accountMessage}
        />
      </View>

      <ConfirmSheet
        visible={signOutOpen}
        title={t("Sign out")}
        body={
          <Text style={styles.sheetText}>
            {t("Are you sure you want to sign out of your account?")}
          </Text>
        }
        confirmLabel={t("Sign out")}
        confirmTone="danger"
        cancelLabel={t("Cancel")}
        busy={signOutAction.busy}
        error={signOutAction.error}
        onConfirm={() => void confirmSignOut()}
        onCancel={() => setSignOutOpen(false)}
      />

      <ConfirmSheet
        visible={removePhotoOpen}
        title={t("Remove photo")}
        body={
          <Text style={styles.sheetText}>
            {t("Remove your profile photo?")}
          </Text>
        }
        confirmLabel={t("Remove")}
        confirmTone="danger"
        cancelLabel={t("Cancel")}
        busy={photoBusy}
        error={removePhotoOpen ? photoError : null}
        onConfirm={() => void removeProfilePhoto()}
        onCancel={() => setRemovePhotoOpen(false)}
      />

      <ConfirmSheet
        visible={freezeActions.sheet !== null}
        title={
          freezeActions.kind === "resume"
            ? t("Resume membership")
            : t("Freeze membership")
        }
        body={
          freezeActions.kind === "resume" ? (
            <Text style={styles.sheetText}>
              {t(
                "Your remaining days start counting again from today. Your end date moves later by the days you were frozen.",
              )}
            </Text>
          ) : freezeAllowance ? (
            <>
              <Text style={styles.sheetText}>
                {t(
                  "Your remaining days stop counting while frozen. The end date moves later by the frozen days, up to {{maxDays}} days.",
                  { maxDays: freezeAllowance.maxDays },
                )}
              </Text>
              <Text style={styles.sheetText}>
                {t("Your next turnstile entry ends the freeze automatically.")}
              </Text>
              <SheetFacts
                rows={[
                  {
                    label: t("Maximum length"),
                    value: t("{{n}} days", { n: freezeAllowance.maxDays }),
                  },
                  {
                    label: t("Used this year"),
                    value: t("{{used}} of {{max}}", {
                      used: freezeAllowance.usedInLastYear,
                      max: freezeAllowance.maxPerYear,
                    }),
                  },
                ]}
              />
            </>
          ) : null
        }
        confirmLabel={
          freezeActions.kind === "resume" ? t("Resume") : t("Freeze")
        }
        cancelLabel={t("Cancel")}
        busy={freezeActions.busy}
        error={freezeActions.error}
        onConfirm={() => void freezeActions.confirm()}
        onCancel={freezeActions.close}
      />
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

    sheetText: { ...theme.type.body, color: theme.colors.textSecondary },
    accountMessage: { marginTop: theme.spacing.sm },
    messages: { gap: theme.spacing.xs, marginTop: theme.spacing.sm },
    section: { marginTop: theme.spacing.xl },

    factLabel: { ...theme.type.supporting, color: theme.colors.textSecondary },

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
