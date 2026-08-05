import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MyBodyMetrics, MyProfile } from "@opengym/shared";
import type { MobileTranslationKey } from "../i18n/resources";
import { api } from "../lib/api";
import {
  CALORIE_LIMITS,
  calculateCaloriePlan,
  cmToFeetAndInches,
  feetAndInchesToCm,
  formatEditable,
  kgToPounds,
  parseLocalizedNumber,
  poundsToKg,
  type ActivityLevel,
  type CalorieGoal,
  type CalorieResult,
  type Sex,
} from "../lib/calorieCalculator";
import { getCalorieIntroArtworkSize } from "../lib/calorieCalculatorLayout";
import {
  loadCalorieCalculatorState,
  saveCalorieCalculatorState,
} from "../lib/calorieCalculatorStorage";
import {
  tabularNumbers,
  useTheme,
  useThemedStyles,
  withAlpha,
  type Theme,
} from "../theme";
import { BackButton, Button, Segmented, StatusMessage, useEnter } from "../ui";
import introArtwork from "../../assets/calorie-octopus-intro.webp";
import resultArtwork from "../../assets/calorie-octopus-result.webp";

type UnitSystem = "metric" | "imperial";
type FlowStage =
  | "intro"
  | "sex"
  | "age"
  | "height"
  | "weight"
  | "activity"
  | "goal"
  | "result";

const INPUT_STAGES: ReadonlyArray<Exclude<FlowStage, "intro" | "result">> = [
  "sex",
  "age",
  "height",
  "weight",
  "activity",
  "goal",
];

const ACTIVITY_OPTIONS: ReadonlyArray<{
  value: ActivityLevel;
  title: MobileTranslationKey;
  body: MobileTranslationKey;
}> = [
  {
    value: "sedentary",
    title: "Sedentary",
    body: "I move very little or do not exercise.",
  },
  {
    value: "light",
    title: "Lightly active",
    body: "I have a lightly active routine and exercise 1–3 days a week.",
  },
  {
    value: "moderate",
    title: "Moderately active",
    body: "I have an active routine and exercise 3–5 days a week.",
  },
  {
    value: "active",
    title: "Very active",
    body: "I am very active and exercise 6–7 days a week.",
  },
  {
    value: "veryActive",
    title: "Extremely active",
    body: "I train intensely or work in a physically demanding job.",
  },
];

const GOAL_OPTIONS: ReadonlyArray<{
  value: CalorieGoal;
  title: MobileTranslationKey;
  body: MobileTranslationKey;
}> = [
  {
    value: "loseFat",
    title: "Lose fat",
    body: "Sets a target 15 percent below your maintenance calories.",
  },
  {
    value: "maintain",
    title: "Maintain weight",
    body: "Uses your estimated daily energy expenditure as the target.",
  },
  {
    value: "gainMuscle",
    title: "Gain muscle",
    body: "Sets a target 10 percent above your maintenance calories.",
  },
];

function formatGoalAdjustment(factor: number, language: string | undefined) {
  const percent = Math.round(Math.abs(factor - 1) * 100);
  const sign = factor < 1 ? "−" : factor > 1 ? "+" : "";
  return language?.startsWith("tr")
    ? `${sign}%${percent}`
    : `${sign}${percent}%`;
}

function StageTransition({ children }: { children: ReactNode }) {
  const enter = useEnter({ distance: 14 });
  return (
    <Animated.View style={[stylesStatic.flex, enter]}>{children}</Animated.View>
  );
}

function ChoiceCard({
  title,
  body,
  selected,
  onPress,
  compact = false,
}: {
  title: string;
  body?: string;
  selected: boolean;
  onPress: () => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(calculatorStyles);

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={title}
      accessibilityHint={body}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        compact && styles.choiceCompact,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
      ]}
    >
      <View style={styles.choiceCopy}>
        <Text style={[styles.choiceTitle, selected && styles.choiceTitleOn]}>
          {title}
        </Text>
        {body ? <Text style={styles.choiceBody}>{body}</Text> : null}
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? (
          <View
            style={[
              styles.radioDot,
              { backgroundColor: theme.colors.onAccent },
            ]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function NumberEntry({
  label,
  value,
  onChangeText,
  suffix,
  error,
  helper,
  integer = false,
  compact = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  suffix: string;
  error?: string | null;
  helper?: string;
  integer?: boolean;
  compact?: boolean;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(calculatorStyles);

  return (
    <View style={[styles.numberEntry, compact && styles.numberEntryCompact]}>
      <View style={styles.numberLine}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          accessibilityLabel={label}
          accessibilityHint={error ?? helper}
          keyboardType={integer ? "number-pad" : "decimal-pad"}
          inputMode={integer ? "numeric" : "decimal"}
          returnKeyType="done"
          maxLength={integer ? 3 : 7}
          placeholder="—"
          placeholderTextColor={theme.colors.textDisabled}
          selectionColor={theme.colors.accent}
          style={[styles.numberInput, compact && styles.numberInputCompact]}
        />
        <Text style={styles.numberSuffix}>{suffix}</Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.inputError}>
          {error}
        </Text>
      ) : helper ? (
        <Text style={styles.inputHelper}>{helper}</Text>
      ) : null}
    </View>
  );
}

function MacroRow({
  color,
  label,
  target,
}: {
  color: string;
  label: string;
  target: { percent: number; grams: number };
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(calculatorStyles);
  return (
    <View style={styles.macroRow}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroValue}>
        {t("{{grams}} g · {{percent}}%", {
          grams: target.grams,
          percent: target.percent,
        })}
      </Text>
    </View>
  );
}

export function CalorieCalculator({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const styles = useThemedStyles(calculatorStyles);
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const [stage, setStage] = useState<FlowStage>("intro");
  const [sex, setSex] = useState<Sex | null>(null);
  const [age, setAge] = useState("");
  const [heightUnit, setHeightUnit] = useState<UnitSystem>("metric");
  const [heightCm, setHeightCm] = useState("");
  const [heightFeet, setHeightFeet] = useState("");
  const [heightInches, setHeightInches] = useState("");
  const [weightUnit, setWeightUnit] = useState<UnitSystem>("metric");
  const [weightKg, setWeightKg] = useState("");
  const [weightLb, setWeightLb] = useState("");
  const [activity, setActivity] = useState<ActivityLevel | null>(null);
  const [goal, setGoal] = useState<CalorieGoal | null>(null);
  // The device cache key is member-specific; the ID comes from the profile request.
  const [userId, setUserId] = useState<string | null>(null);
  const [profileSyncFailed, setProfileSyncFailed] = useState(false);

  const introArtworkSize = getCalorieIntroArtworkSize(viewport);
  const compactIntro = introArtworkSize < 228;

  const language = i18n.resolvedLanguage;
  const ageValue = parseLocalizedNumber(age);
  const ageValid =
    ageValue != null &&
    Number.isInteger(ageValue) &&
    ageValue >= CALORIE_LIMITS.age.min &&
    ageValue <= CALORIE_LIMITS.age.max;

  const metricHeightValue = parseLocalizedNumber(heightCm);
  const feetValue = parseLocalizedNumber(heightFeet);
  const inchesValue = parseLocalizedNumber(heightInches);
  const normalizedHeight =
    heightUnit === "metric"
      ? metricHeightValue
      : feetValue != null &&
          Number.isInteger(feetValue) &&
          inchesValue != null &&
          inchesValue >= 0 &&
          inchesValue < 12
        ? feetAndInchesToCm(feetValue, inchesValue)
        : null;
  const heightValid =
    normalizedHeight != null &&
    normalizedHeight >= CALORIE_LIMITS.heightCm.min &&
    normalizedHeight <= CALORIE_LIMITS.heightCm.max;

  const metricWeightValue = parseLocalizedNumber(weightKg);
  const imperialWeightValue = parseLocalizedNumber(weightLb);
  const normalizedWeight =
    weightUnit === "metric"
      ? metricWeightValue
      : imperialWeightValue == null
        ? null
        : poundsToKg(imperialWeightValue);
  const weightValid =
    normalizedWeight != null &&
    normalizedWeight >= CALORIE_LIMITS.weightKg.min &&
    normalizedWeight <= CALORIE_LIMITS.weightKg.max;

  const result: CalorieResult | null =
    sex && ageValid && heightValid && weightValid && activity && goal
      ? calculateCaloriePlan({
          sex,
          age: ageValue!,
          heightCm: normalizedHeight!,
          weightKg: normalizedWeight!,
          activity,
          goal,
        })
      : null;

  // If a flow was previously completed on this device, prefill its fields;
  // otherwise, the height and weight saved to the member's profile (if present)
  // fill only those two fields. The user only needs to confirm or correct them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Device cache uses a member-specific key, so the ID is needed first: if
      // the profile cannot be read, the flow starts empty.
      let profile: MyProfile | null = null;
      try {
        profile = await api<MyProfile>("/api/me/profile");
      } catch {
        // Without an ID, nothing can be written to the device or profile; the
        // result-screen warning explains this to the member, and the flow starts empty.
        if (!cancelled) setProfileSyncFailed(true);
        return;
      }
      if (cancelled) return;
      setUserId(profile.id);

      const cached = await loadCalorieCalculatorState(profile.id);
      if (cancelled) return;
      if (cached) {
        setSex(cached.sex);
        setAge(String(cached.age));
        setHeightUnit(cached.heightUnit);
        setWeightUnit(cached.weightUnit);
        if (cached.heightUnit === "imperial") {
          const converted = cmToFeetAndInches(cached.heightCm);
          setHeightFeet(String(converted.feet));
          setHeightInches(formatEditable(converted.inches, language));
        } else {
          setHeightCm(formatEditable(cached.heightCm, language));
        }
        if (cached.weightUnit === "imperial") {
          setWeightLb(formatEditable(kgToPounds(cached.weightKg), language));
        } else {
          setWeightKg(formatEditable(cached.weightKg, language));
        }
        setActivity(cached.activity);
        setGoal(cached.goal);
        return;
      }
      // If the device has no saved state, values in the member's profile fill
      // those fields; the user only needs to confirm or correct them.
      if (typeof profile.age === "number") {
        setAge(String(profile.age));
      }
      if (typeof profile.heightCm === "number") {
        setHeightCm(formatEditable(profile.heightCm, language));
      }
      if (typeof profile.weightKg === "number") {
        setWeightKg(formatEditable(profile.weightKg, language));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs only on the initial mount: it prefills the next calculation without
    // overwriting fields when the language changes during an active flow.
  }, []);

  // Upon reaching the result screen, inputs are saved on this device; age,
  // height, and weight are also written to the member's profile for next time.
  useEffect(() => {
    if (
      stage !== "result" ||
      sex == null ||
      ageValue == null ||
      normalizedHeight == null ||
      normalizedWeight == null ||
      activity == null ||
      goal == null
    ) {
      return;
    }
    // Device cache uses a member-specific key; nothing is written if the ID is
    // unknown, and the result screen shows a warning.
    if (userId == null) {
      setProfileSyncFailed(true);
      return;
    }

    void saveCalorieCalculatorState(userId, {
      sex,
      age: ageValue,
      heightCm: normalizedHeight,
      weightKg: normalizedWeight,
      activity,
      goal,
      heightUnit,
      weightUnit,
    });
    // A profile-write failure cannot be swallowed silently: the member should
    // understand why fields may be empty next time. The calculation is still shown.
    void (async () => {
      try {
        await api<MyBodyMetrics>("/api/me/body-metrics", {
          method: "PATCH",
          body: {
            age: ageValue,
            heightCm: normalizedHeight,
            weightKg: normalizedWeight,
          },
        });
        setProfileSyncFailed(false);
      } catch {
        setProfileSyncFailed(true);
      }
    })();
  }, [
    stage,
    userId,
    sex,
    ageValue,
    normalizedHeight,
    normalizedWeight,
    activity,
    goal,
    heightUnit,
    weightUnit,
  ]);

  const heightHasValue =
    heightUnit === "metric"
      ? heightCm.trim().length > 0
      : heightFeet.trim().length > 0 || heightInches.trim().length > 0;
  const weightHasValue =
    weightUnit === "metric"
      ? weightKg.trim().length > 0
      : weightLb.trim().length > 0;
  const ageError =
    age.length > 0 && !ageValid
      ? t("Enter a whole-number age between 18 and 80.")
      : null;
  const heightError =
    heightHasValue && !heightValid
      ? t("Enter a valid height in the 120–230 cm range.")
      : null;
  const weightError =
    weightHasValue && !weightValid
      ? t("Enter a valid weight in the 35–300 kg range.")
      : null;

  const currentStep = INPUT_STAGES.indexOf(
    stage as Exclude<FlowStage, "intro" | "result">,
  );
  const progressStep =
    stage === "result" ? INPUT_STAGES.length : currentStep + 1;
  const showProgress = stage !== "intro";
  const progressWidth = `${Math.max(
    0,
    Math.min(100, (progressStep / INPUT_STAGES.length) * 100),
  )}%` as `${number}%`;

  const canContinue =
    stage === "intro" ||
    (stage === "sex" && sex != null) ||
    (stage === "age" && ageValid) ||
    (stage === "height" && heightValid) ||
    (stage === "weight" && weightValid) ||
    (stage === "activity" && activity != null) ||
    (stage === "goal" && result != null);

  const goBack = useCallback(() => {
    if (stage === "intro") {
      onClose();
      return;
    }
    if (stage === "result") {
      setStage("goal");
      return;
    }
    const index = INPUT_STAGES.indexOf(stage);
    setStage(index <= 0 ? "intro" : INPUT_STAGES[index - 1]!);
  }, [onClose, stage]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        goBack();
        return true;
      },
    );
    return () => subscription.remove();
  }, [goBack]);

  function goNext() {
    if (!canContinue) return;
    if (stage === "intro") {
      setStage("sex");
      return;
    }
    if (stage === "goal") {
      setStage("result");
      return;
    }
    const index = INPUT_STAGES.indexOf(stage);
    if (index >= 0 && index < INPUT_STAGES.length - 1) {
      setStage(INPUT_STAGES[index + 1]!);
    }
  }

  function changeHeightUnit(next: UnitSystem) {
    if (next === heightUnit) return;
    if (next === "imperial" && metricHeightValue != null) {
      const converted = cmToFeetAndInches(metricHeightValue);
      setHeightFeet(String(converted.feet));
      setHeightInches(formatEditable(converted.inches, language));
    } else if (next === "metric" && feetValue != null && inchesValue != null) {
      setHeightCm(
        formatEditable(feetAndInchesToCm(feetValue, inchesValue), language),
      );
    }
    setHeightUnit(next);
  }

  function changeWeightUnit(next: UnitSystem) {
    if (next === weightUnit) return;
    if (next === "imperial" && metricWeightValue != null) {
      setWeightLb(formatEditable(kgToPounds(metricWeightValue), language));
    } else if (next === "metric" && imperialWeightValue != null) {
      setWeightKg(formatEditable(poundsToKg(imperialWeightValue), language));
    }
    setWeightUnit(next);
  }

  function stepContent() {
    switch (stage) {
      case "intro":
        return (
          <View style={[styles.intro, compactIntro && styles.introCompact]}>
            <Image
              source={introArtwork}
              resizeMode="contain"
              accessible={false}
              accessibilityIgnoresInvertColors
              style={[
                styles.introArtwork,
                { width: introArtworkSize, height: introArtworkSize },
              ]}
            />
            <Text accessibilityRole="header" style={styles.heroTitle}>
              {t("Let's find your daily energy needs")}
            </Text>
            <Text style={styles.heroBody}>
              {t(
                "Estimate your daily calorie target and macro split with six quick questions.",
              )}
            </Text>
            <View style={styles.privacyNote}>
              <StatusMessage
                tone="neutral"
                text={t(
                  "Your answers are stored on this device; your height and weight are also saved to your profile so they auto-fill next time.",
                )}
              />
            </View>
          </View>
        );
      case "sex":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("Which biological parameter should the calculation use?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "The Mifflin–St Jeor equation uses different constants for female and male bodies.",
              )}
            </Text>
            <View
              accessibilityRole="radiogroup"
              style={styles.twoColumnChoices}
            >
              <View style={styles.twoColumnChoice}>
                <ChoiceCard
                  title={t("Female")}
                  selected={sex === "female"}
                  onPress={() => setSex("female")}
                  compact
                />
              </View>
              <View style={styles.twoColumnChoice}>
                <ChoiceCard
                  title={t("Male")}
                  selected={sex === "male"}
                  onPress={() => setSex("male")}
                  compact
                />
              </View>
            </View>
          </View>
        );
      case "age":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("How old are you?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("This tool is designed for adults aged 18–80.")}
            </Text>
            <NumberEntry
              label={t("Age")}
              value={age}
              onChangeText={setAge}
              suffix={t("years")}
              error={ageError}
              helper={t("Ages 18–80")}
              integer
            />
          </View>
        );
      case "height":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("How tall are you?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("Choose the unit you prefer; you can change the value later.")}
            </Text>
            <View style={styles.unitSwitch}>
              <Segmented
                accessibilityLabel={t("Height unit")}
                value={heightUnit}
                onChange={changeHeightUnit}
                options={[
                  { value: "metric", label: "cm" },
                  { value: "imperial", label: "ft / in" },
                ]}
              />
            </View>
            {heightUnit === "metric" ? (
              <NumberEntry
                label={t("Height")}
                value={heightCm}
                onChangeText={setHeightCm}
                suffix="cm"
                error={heightError}
                helper={t("120–230 cm")}
              />
            ) : (
              <View>
                <View style={styles.imperialRow}>
                  <NumberEntry
                    label={t("Feet")}
                    value={heightFeet}
                    onChangeText={setHeightFeet}
                    suffix="ft"
                    integer
                    compact
                  />
                  <NumberEntry
                    label={t("Inches")}
                    value={heightInches}
                    onChangeText={setHeightInches}
                    suffix="in"
                    compact
                  />
                </View>
                {heightError ? (
                  <Text accessibilityRole="alert" style={styles.inputError}>
                    {heightError}
                  </Text>
                ) : (
                  <Text style={styles.inputHelper}>{t("120–230 cm")}</Text>
                )}
              </View>
            )}
          </View>
        );
      case "weight":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("What is your current weight?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("An estimate is fine; decimal values are supported.")}
            </Text>
            <View style={styles.unitSwitch}>
              <Segmented
                accessibilityLabel={t("Weight unit")}
                value={weightUnit}
                onChange={changeWeightUnit}
                options={[
                  { value: "metric", label: "kg" },
                  { value: "imperial", label: "lb" },
                ]}
              />
            </View>
            <NumberEntry
              label={t("Weight")}
              value={weightUnit === "metric" ? weightKg : weightLb}
              onChangeText={weightUnit === "metric" ? setWeightKg : setWeightLb}
              suffix={weightUnit === "metric" ? "kg" : "lb"}
              error={weightError}
              helper={t("35–300 kg")}
            />
          </View>
        );
      case "activity":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("How active are you during the day?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("Think about your average routine over the last few weeks.")}
            </Text>
            <View accessibilityRole="radiogroup" style={styles.choiceList}>
              {ACTIVITY_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.value}
                  title={t(option.title)}
                  body={t(option.body)}
                  selected={activity === option.value}
                  onPress={() => setActivity(option.value)}
                />
              ))}
            </View>
          </View>
        );
      case "goal":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("What is your goal?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "Your goal sets a small, sustainable adjustment to maintenance calories.",
              )}
            </Text>
            <View accessibilityRole="radiogroup" style={styles.choiceList}>
              {GOAL_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.value}
                  title={t(option.title)}
                  body={t(option.body)}
                  selected={goal === option.value}
                  onPress={() => setGoal(option.value)}
                />
              ))}
            </View>
          </View>
        );
      case "result":
        return result ? (
          <View style={styles.result}>
            <Image
              source={resultArtwork}
              resizeMode="contain"
              accessible={false}
              accessibilityIgnoresInvertColors
              style={styles.resultArtwork}
            />
            <Text accessibilityRole="header" style={styles.resultTitle}>
              {t("Your daily target is ready")}
            </Text>
            <View style={styles.calorieMetric}>
              <Text style={styles.calorieNumber}>
                {new Intl.NumberFormat(language).format(result.targetCalories)}
              </Text>
              <Text style={styles.calorieUnit}>{t("kcal / day")}</Text>
            </View>
            <Text style={styles.maintenanceText}>
              {t("Maintenance calories: {{calories}} kcal", {
                calories: new Intl.NumberFormat(language).format(
                  result.maintenanceCalories,
                ),
              })}
            </Text>

            {profileSyncFailed ? (
              <View style={styles.syncWarning}>
                <StatusMessage
                  tone="neutral"
                  text={t(
                    "Your details could not be saved to your profile; this calculation is still valid, but the fields may not auto-fill next time.",
                  )}
                />
              </View>
            ) : null}

            <View style={styles.resultSection}>
              <Text style={styles.resultSectionTitle}>{t("Daily macros")}</Text>
              <View
                style={styles.macroBar}
                accessibilityLabel={t(
                  "Macro split: {{protein}} percent protein, {{carbohydrate}} percent carbohydrate, {{fat}} percent fat",
                  {
                    protein: result.macros.protein.percent,
                    carbohydrate: result.macros.carbohydrate.percent,
                    fat: result.macros.fat.percent,
                  },
                )}
              >
                <View
                  style={[
                    styles.macroSegment,
                    {
                      width: `${result.macros.protein.percent}%`,
                      backgroundColor: theme.colors.error,
                    },
                  ]}
                />
                <View
                  style={[
                    styles.macroSegment,
                    {
                      width: `${result.macros.carbohydrate.percent}%`,
                      backgroundColor: theme.colors.warning,
                    },
                  ]}
                />
                <View
                  style={[
                    styles.macroSegment,
                    {
                      width: `${result.macros.fat.percent}%`,
                      backgroundColor: theme.colors.accent,
                    },
                  ]}
                />
              </View>
              <View style={styles.macroList}>
                <MacroRow
                  color={theme.colors.error}
                  label={t("Protein")}
                  target={result.macros.protein}
                />
                <MacroRow
                  color={theme.colors.warning}
                  label={t("Carbohydrate")}
                  target={result.macros.carbohydrate}
                />
                <MacroRow
                  color={theme.colors.accent}
                  label={t("Fat")}
                  target={result.macros.fat}
                />
              </View>
            </View>

            <View style={styles.methodPanel}>
              <Text style={styles.methodTitle}>
                {t("How was this calculated?")}
              </Text>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>
                  {t("Basal metabolic rate")}
                </Text>
                <Text style={styles.methodValue}>
                  {new Intl.NumberFormat(language).format(result.bmr)} kcal
                </Text>
              </View>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>
                  {t("Activity multiplier")}
                </Text>
                <Text style={styles.methodValue}>
                  ×
                  {new Intl.NumberFormat(language, {
                    maximumFractionDigits: 3,
                  }).format(result.activityMultiplier)}
                </Text>
              </View>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>{t("Goal adjustment")}</Text>
                <Text style={styles.methodValue}>
                  {formatGoalAdjustment(result.goalFactor, language)}
                </Text>
              </View>
            </View>

            <StatusMessage
              tone="warning"
              text={t(
                "This result is an estimate for the general adult population. Consult a health professional for pregnancy, breastfeeding, specific health conditions or professional athletics.",
              )}
            />
          </View>
        ) : null;
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <BackButton onPress={goBack} />
        {showProgress ? (
          <View style={styles.progressGroup}>
            <View
              accessibilityRole="progressbar"
              accessibilityValue={{
                min: 1,
                max: INPUT_STAGES.length,
                now: progressStep,
                text: t("Step {{current}} of {{total}}", {
                  current: progressStep,
                  total: INPUT_STAGES.length,
                }),
              }}
              style={styles.progressTrack}
            >
              <View style={[styles.progressFill, { width: progressWidth }]} />
            </View>
            <Text style={styles.stepCounter}>
              {stage === "result"
                ? t("Complete")
                : t("{{current}} / {{total}}", {
                    current: progressStep,
                    total: INPUT_STAGES.length,
                  })}
            </Text>
          </View>
        ) : (
          <View style={styles.progressPlaceholder} />
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: theme.spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        automaticallyAdjustKeyboardInsets
      >
        <StageTransition key={stage}>{stepContent()}</StageTransition>
      </ScrollView>

      <View
        style={[
          styles.footer,
          { paddingBottom: Math.max(insets.bottom, theme.spacing.md) },
        ]}
      >
        {stage === "result" ? (
          <>
            <Button
              title={t("Edit values")}
              variant="secondary"
              onPress={() => setStage("sex")}
              style={styles.footerButton}
            />
            <Button
              title={t("Return to Tools")}
              onPress={onClose}
              style={styles.footerButton}
            />
          </>
        ) : (
          <Button
            title={stage === "intro" ? t("Start calculation") : t("Continue")}
            onPress={goNext}
            disabled={!canContinue}
            style={styles.footerButton}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const stylesStatic = StyleSheet.create({ flex: { flex: 1 } });

const calculatorStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.background },
    topBar: {
      minHeight: 62,
      paddingHorizontal: theme.spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.background,
    },
    progressGroup: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    progressPlaceholder: { flex: 1 },
    progressTrack: {
      flex: 1,
      height: 8,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.colors.surfaceRaised,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      borderRadius: theme.radius.pill,
      backgroundColor: theme.colors.accent,
    },
    stepCounter: {
      ...theme.type.micro,
      ...tabularNumbers,
      color: theme.colors.textTertiary,
      minWidth: 34,
      textAlign: "right",
    },
    scroll: { flex: 1 },
    scrollContent: {
      flexGrow: 1,
      width: "100%",
      maxWidth: 560,
      alignSelf: "center",
      paddingHorizontal: theme.spacing.gutter,
    },
    stepContent: {
      flex: 1,
      paddingTop: theme.spacing.xxl,
    },
    stepTitle: {
      ...theme.type.screenTitle,
      color: theme.colors.textPrimary,
      textAlign: "center",
    },
    stepBody: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.sm,
      alignSelf: "center",
      maxWidth: 430,
    },
    intro: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingTop: theme.spacing.sm,
    },
    introCompact: {
      justifyContent: "flex-start",
      paddingTop: theme.spacing.xs,
    },
    introArtwork: {
      marginBottom: theme.spacing.xs,
    },
    heroTitle: {
      ...theme.type.display,
      color: theme.colors.textPrimary,
      textAlign: "center",
      maxWidth: 430,
    },
    heroBody: {
      ...theme.type.body,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.sm,
      maxWidth: 430,
    },
    privacyNote: {
      width: "100%",
      maxWidth: 430,
      marginTop: theme.spacing.xl,
    },
    twoColumnChoices: {
      flexDirection: "row",
      gap: theme.spacing.md,
      marginTop: theme.spacing.xxl,
    },
    twoColumnChoice: { flex: 1 },
    choiceList: { gap: theme.spacing.sm, marginTop: theme.spacing.xl },
    choice: {
      minHeight: 76,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: theme.radius.control,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineStrong,
      backgroundColor: theme.colors.surface,
    },
    choiceCompact: {
      minHeight: 118,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    choiceSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accentSurface,
    },
    choicePressed: { opacity: 0.72 },
    choiceCopy: { flex: 1 },
    choiceTitle: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
    },
    choiceTitleOn: { color: theme.colors.accent },
    choiceBody: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xxs,
    },
    radio: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    radioSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    radioDot: { width: 7, height: 7, borderRadius: 4 },
    unitSwitch: {
      width: 220,
      maxWidth: "100%",
      alignSelf: "center",
      marginTop: theme.spacing.xl,
    },
    numberEntry: {
      width: "100%",
      maxWidth: 360,
      alignSelf: "center",
      marginTop: theme.spacing.xxxl,
    },
    numberEntryCompact: {
      flex: 1,
      marginTop: theme.spacing.xl,
    },
    numberLine: {
      minHeight: 78,
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "center",
      gap: theme.spacing.xs,
      borderBottomWidth: 2,
      borderBottomColor: theme.colors.outlineStrong,
    },
    numberInput: {
      minWidth: 94,
      paddingVertical: 8,
      ...theme.type.metric,
      ...tabularNumbers,
      fontSize: 50,
      lineHeight: 58,
      color: theme.colors.textPrimary,
      textAlign: "right",
    },
    numberInputCompact: { minWidth: 58, fontSize: 38, lineHeight: 48 },
    numberSuffix: {
      ...theme.type.title,
      color: theme.colors.textSecondary,
      paddingBottom: 14,
    },
    inputError: {
      ...theme.type.supporting,
      color: theme.colors.error,
      textAlign: "center",
      marginTop: theme.spacing.sm,
    },
    inputHelper: {
      ...theme.type.supporting,
      color: theme.colors.textTertiary,
      textAlign: "center",
      marginTop: theme.spacing.sm,
    },
    imperialRow: {
      flexDirection: "row",
      gap: theme.spacing.lg,
      maxWidth: 360,
      alignSelf: "center",
    },
    result: {
      alignItems: "stretch",
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.lg,
    },
    resultArtwork: {
      width: 188,
      height: 188,
      alignSelf: "center",
    },
    resultTitle: {
      ...theme.type.screenTitle,
      color: theme.colors.textPrimary,
      textAlign: "center",
      marginTop: -theme.spacing.xs,
    },
    calorieMetric: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "center",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.md,
    },
    calorieNumber: {
      ...theme.type.metric,
      ...tabularNumbers,
      color: theme.colors.accent,
    },
    calorieUnit: {
      ...theme.type.title,
      color: theme.colors.textSecondary,
    },
    maintenanceText: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      textAlign: "center",
      marginTop: theme.spacing.xxs,
    },
    syncWarning: { marginTop: theme.spacing.md },
    resultSection: { marginTop: theme.spacing.xxl },
    resultSectionTitle: {
      ...theme.type.sectionTitle,
      color: theme.colors.textPrimary,
    },
    macroBar: {
      height: 12,
      flexDirection: "row",
      overflow: "hidden",
      borderRadius: theme.radius.pill,
      marginTop: theme.spacing.md,
      backgroundColor: theme.colors.surfaceRaised,
    },
    macroSegment: { height: "100%" },
    macroList: { marginTop: theme.spacing.md },
    macroRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.outline,
    },
    macroDot: { width: 9, height: 9, borderRadius: 5 },
    macroLabel: {
      ...theme.type.body,
      color: theme.colors.textPrimary,
      flex: 1,
    },
    macroValue: {
      ...theme.type.body,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
    },
    methodPanel: {
      marginTop: theme.spacing.xl,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.card,
      backgroundColor: theme.colors.surfaceRaised,
    },
    methodTitle: {
      ...theme.type.title,
      color: theme.colors.textPrimary,
      marginBottom: theme.spacing.sm,
    },
    methodRow: {
      minHeight: 34,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    methodLabel: {
      ...theme.type.supporting,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    methodValue: {
      ...theme.type.supporting,
      ...tabularNumbers,
      fontWeight: "600",
      color: theme.colors.textPrimary,
    },
    footer: {
      width: "100%",
      maxWidth: 560,
      alignSelf: "center",
      flexDirection: "column",
      gap: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      paddingHorizontal: theme.spacing.gutter,
      backgroundColor: theme.colors.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withAlpha(theme.colors.textPrimary, 0.08),
    },
    footerButton: { width: "100%" },
  });
