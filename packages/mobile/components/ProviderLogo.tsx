import { BRAND_COLORS, PROVIDER_LABELS, providerLogoType } from "@dofek/providers/providers";
import { Image, StyleSheet, Text, View } from "react-native";

interface ProviderLogoProps {
  /** Provider ID (e.g. "strava", "wahoo") */
  provider: string;
  /** Server base URL for loading logo assets */
  serverUrl: string;
  /** Width & height in px (default 20) */
  size?: number;
}

function logoUrl(serverUrl: string, provider: string): string | null {
  const type = providerLogoType(provider);
  if (type) return `${serverUrl}/logos/${provider}.${type}`;
  return null;
}

export function ProviderLogo({ provider, serverUrl, size = 20 }: ProviderLogoProps) {
  const url = logoUrl(serverUrl, provider);

  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size }}
        accessibilityElementsHidden
      />
    );
  }

  // Styled letter fallback for providers without a logo file
  const label = PROVIDER_LABELS[provider] ?? provider;
  const letter = label[0]?.toUpperCase() ?? "?";
  const color = BRAND_COLORS[provider] ?? "#6b8a6b";
  const fontSize = Math.round(size * 0.55);

  return (
    <View
      style={[
        styles.letterContainer,
        { width: size, height: size, backgroundColor: color, borderRadius: size * 0.2 },
      ]}
      accessibilityElementsHidden
    >
      <Text style={[styles.letter, { fontSize }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  letterContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    color: "#fff",
    fontWeight: "600",
  },
});
