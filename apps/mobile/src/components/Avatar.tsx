import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useThemedStyles, type Theme } from "../theme";

/**
 * Profil görseli. Fotoğraf yoksa ya da yüklenemezse baş harflere düşer —
 * boş bir daire hiçbir zaman görünmez.
 *
 * Ana Sayfa başlığı ile Profil ekranı aynı bileşeni kullanır; aynı kişi iki
 * ekranda farklı görünmemeli.
 */
export function Avatar({
  size,
  name,
  photoUrl,
  locale,
}: {
  size: number;
  name: string;
  photoUrl: string | null;
  /** Baş harflerin doğru büyütülmesi için (ör. "i" → "İ"). */
  locale: string;
}) {
  const styles = useThemedStyles(avatarStyles);
  const [failed, setFailed] = useState(false);

  // Yeni fotoğraf yüklendiğinde önceki hata durumu takılı kalmasın.
  useEffect(() => {
    setFailed(false);
  }, [photoUrl]);

  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase(locale) ?? "")
      .join("") || "O";

  return (
    <View
      style={[
        styles.root,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      {photoUrl && !failed ? (
        <Image
          source={{ uri: photoUrl }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          accessibilityIgnoresInvertColors
          onError={() => setFailed(true)}
        />
      ) : (
        <Text
          maxFontSizeMultiplier={1.2}
          style={[
            styles.initials,
            { fontSize: size * 0.36, lineHeight: size * 0.44 },
          ]}
        >
          {initials}
        </Text>
      )}
    </View>
  );
}

const avatarStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      backgroundColor: theme.colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    initials: { fontWeight: "700", color: theme.colors.textPrimary },
  });
