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
    title: "Hareketsiz",
    body: "Çok az hareket ediyorum veya egzersiz yapmıyorum.",
  },
  {
    value: "light",
    title: "Az hareketli",
    body: "Hafif hareketli bir yaşamım var; haftada 1–3 gün egzersiz yapıyorum.",
  },
  {
    value: "moderate",
    title: "Orta hareketli",
    body: "Hareketli bir yaşamım var; haftada 3–5 gün egzersiz yapıyorum.",
  },
  {
    value: "active",
    title: "Çok hareketli",
    body: "Çok hareketliyim; haftada 6–7 gün egzersiz yapıyorum.",
  },
  {
    value: "veryActive",
    title: "Aşırı hareketli",
    body: "Yoğun antrenman yapıyorum veya fiziksel bir işte çalışıyorum.",
  },
];

const GOAL_OPTIONS: ReadonlyArray<{
  value: CalorieGoal;
  title: MobileTranslationKey;
  body: MobileTranslationKey;
}> = [
  {
    value: "loseFat",
    title: "Yağ kaybet",
    body: "Bakım kalorinden yüzde 15 daha düşük bir hedef oluşturur.",
  },
  {
    value: "maintain",
    title: "Kiloyu koru",
    body: "Tahmini günlük enerji harcamanı hedef olarak kullanır.",
  },
  {
    value: "gainMuscle",
    title: "Kas kazan",
    body: "Bakım kalorinden yüzde 10 daha yüksek bir hedef oluşturur.",
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
        {t("{{grams}} g · %{{percent}}", {
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
  // Cihaz cache'inin anahtarı üyeye özeldir; kimlik profil okumasından gelir.
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

  // Bu cihazda daha önce tamamlanmış bir akış varsa alanları önceden
  // doldurur; yoksa üyenin profiline kaydettiği boy/kilo (varsa) yalnızca o
  // iki alanı doldurur. Kullanıcıya sadece onaylamak/düzeltmek düşer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cihaz cache'i üyeye özel anahtar altında saklanır, bu yüzden önce
      // kimlik gerekir: profil okunamazsa akış boş başlar.
      let profile: MyProfile | null = null;
      try {
        profile = await api<MyProfile>("/api/me/profile");
      } catch {
        // Kimlik alınamadıysa ne cihaza ne profile yazabiliriz; sonuç
        // ekranındaki uyarı bunu üyeye söyler, akış boş başlar.
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
      // Cihazda kayıt yoksa üyenin profiline yazdığı değerler o alanları
      // doldurur; kullanıcıya sadece onaylamak/düzeltmek düşer.
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
    // Yalnızca ilk montajda çalışır: bir dahaki hesaplamayı önceden doldurmak
    // için, akış zaten sürerken dil değişiminde alanları ezmemeli.
  }, []);

  // Sonuç ekranına ulaşılınca girdiler bu cihaza kaydedilir; yaş/boy/kilo
  // ayrıca üyenin profiline de yazılır (bir dahaki hesaplamayı otomatik doldursun).
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
    // Cihaz cache'i üyeye özel anahtar altında; kimlik bilinmiyorsa yazılmaz
    // ve bu durum sonuç ekranında uyarı olarak görünür.
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
    // Profile yazım sessizce yutulamaz: başarısız olursa üye bir dahaki sefere
    // alanların neden boş geldiğini anlamalı. Hesaplama yine de gösterilir.
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
      ? t("18 ile 80 arasında tam bir yaş girin.")
      : null;
  const heightError =
    heightHasValue && !heightValid
      ? t("120–230 cm aralığında geçerli bir boy girin.")
      : null;
  const weightError =
    weightHasValue && !weightValid
      ? t("35–300 kg aralığında geçerli bir kilo girin.")
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
              {t("Günlük enerjini birlikte bulalım")}
            </Text>
            <Text style={styles.heroBody}>
              {t(
                "Altı kısa soruyla günlük kalori hedefini ve makro dağılımını tahmin et.",
              )}
            </Text>
            <View style={styles.privacyNote}>
              <StatusMessage
                tone="neutral"
                text={t(
                  "Girdiğin bilgiler bu cihazda saklanır; boy ve kilon, bir dahaki sefere otomatik dolması için profiline de kaydedilir.",
                )}
              />
            </View>
          </View>
        );
      case "sex":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("Hesaplamada hangi biyolojik parametre kullanılsın?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "Mifflin–St Jeor denklemi kadın ve erkek için farklı sabitler kullanır.",
              )}
            </Text>
            <View
              accessibilityRole="radiogroup"
              style={styles.twoColumnChoices}
            >
              <View style={styles.twoColumnChoice}>
                <ChoiceCard
                  title={t("Kadın")}
                  selected={sex === "female"}
                  onPress={() => setSex("female")}
                  compact
                />
              </View>
              <View style={styles.twoColumnChoice}>
                <ChoiceCard
                  title={t("Erkek")}
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
              {t("Kaç yaşındasın?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("Bu araç 18–80 yaş arasındaki yetişkinler için tasarlandı.")}
            </Text>
            <NumberEntry
              label={t("Yaş")}
              value={age}
              onChangeText={setAge}
              suffix={t("yaş")}
              error={ageError}
              helper={t("18–80 yaş")}
              integer
            />
          </View>
        );
      case "height":
        return (
          <View style={styles.stepContent}>
            <Text accessibilityRole="header" style={styles.stepTitle}>
              {t("Boyun kaç?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "İstediğin birimi seçebilir, değeri daha sonra değiştirebilirsin.",
              )}
            </Text>
            <View style={styles.unitSwitch}>
              <Segmented
                accessibilityLabel={t("Boy birimi")}
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
                label={t("Boy")}
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
                    label={t("Fit")}
                    value={heightFeet}
                    onChangeText={setHeightFeet}
                    suffix="ft"
                    integer
                    compact
                  />
                  <NumberEntry
                    label={t("İnç")}
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
              {t("Güncel kilon kaç?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "Yaklaşık bir değer girebilirsin; ondalık değerler desteklenir.",
              )}
            </Text>
            <View style={styles.unitSwitch}>
              <Segmented
                accessibilityLabel={t("Kilo birimi")}
                value={weightUnit}
                onChange={changeWeightUnit}
                options={[
                  { value: "metric", label: "kg" },
                  { value: "imperial", label: "lb" },
                ]}
              />
            </View>
            <NumberEntry
              label={t("Kilo")}
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
              {t("Gün içinde ne kadar hareketlisin?")}
            </Text>
            <Text style={styles.stepBody}>
              {t("Son birkaç haftadaki ortalama düzenini düşün.")}
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
              {t("Hedefin nedir?")}
            </Text>
            <Text style={styles.stepBody}>
              {t(
                "Hedef, bakım kalorine uygulanacak küçük ve sürdürülebilir farkı belirler.",
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
              {t("Günlük hedefin hazır")}
            </Text>
            <View style={styles.calorieMetric}>
              <Text style={styles.calorieNumber}>
                {new Intl.NumberFormat(language).format(result.targetCalories)}
              </Text>
              <Text style={styles.calorieUnit}>{t("kcal / gün")}</Text>
            </View>
            <Text style={styles.maintenanceText}>
              {t("Bakım kalorisi: {{calories}} kcal", {
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
                    "Bilgilerin profiline kaydedilemedi; bu hesaplama geçerli ama alanlar bir dahaki sefere otomatik dolmayabilir.",
                  )}
                />
              </View>
            ) : null}

            <View style={styles.resultSection}>
              <Text style={styles.resultSectionTitle}>
                {t("Günlük makrolar")}
              </Text>
              <View
                style={styles.macroBar}
                accessibilityLabel={t(
                  "Makro dağılımı: yüzde {{protein}} protein, yüzde {{carbohydrate}} karbonhidrat, yüzde {{fat}} yağ",
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
                  label={t("Karbonhidrat")}
                  target={result.macros.carbohydrate}
                />
                <MacroRow
                  color={theme.colors.accent}
                  label={t("Yağ")}
                  target={result.macros.fat}
                />
              </View>
            </View>

            <View style={styles.methodPanel}>
              <Text style={styles.methodTitle}>{t("Nasıl hesaplandı?")}</Text>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>{t("Bazal metabolizma")}</Text>
                <Text style={styles.methodValue}>
                  {new Intl.NumberFormat(language).format(result.bmr)} kcal
                </Text>
              </View>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>{t("Hareket çarpanı")}</Text>
                <Text style={styles.methodValue}>
                  ×
                  {new Intl.NumberFormat(language, {
                    maximumFractionDigits: 3,
                  }).format(result.activityMultiplier)}
                </Text>
              </View>
              <View style={styles.methodRow}>
                <Text style={styles.methodLabel}>{t("Hedef ayarı")}</Text>
                <Text style={styles.methodValue}>
                  {formatGoalAdjustment(result.goalFactor, language)}
                </Text>
              </View>
            </View>

            <StatusMessage
              tone="warning"
              text={t(
                "Bu sonuç genel yetişkinler için bir tahmindir. Hamilelik, emzirme, özel sağlık durumu veya profesyonel sporculukta bir sağlık uzmanına danışın.",
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
                text: t("{{current}} / {{total}} adım", {
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
                ? t("Tamamlandı")
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
              title={t("Değerleri düzenle")}
              variant="secondary"
              onPress={() => setStage("sex")}
              style={styles.footerButton}
            />
            <Button
              title={t("Araçlara dön")}
              onPress={onClose}
              style={styles.footerButton}
            />
          </>
        ) : (
          <Button
            title={stage === "intro" ? t("Hesaplamaya başla") : t("Devam")}
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
