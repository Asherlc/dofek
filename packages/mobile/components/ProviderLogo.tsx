import {
  BRAND_COLORS,
  PROVIDER_LABELS,
  providerLogoId,
  providerLogoType,
  providerSourceLogo,
} from "@dofek/providers/providers";
import { Image, StyleSheet, Text, View } from "react-native";
import { SvgUri } from "react-native-svg";
import { captureException } from "../lib/telemetry";

interface ProviderLogoProps {
  /** Provider ID (e.g. "strava", "wahoo") */
  provider: string;
  sourceName?: string | null;
  /** Server base URL for loading logo assets */
  serverUrl: string;
  /** Width & height in px (default 20) */
  size?: number;
}

function logoUrl(serverUrl: string, provider: string): string | null {
  const type = providerLogoType(provider);
  if (type) return `${serverUrl}/logos/${providerLogoId(provider)}.${type}`;
  return null;
}

export function ProviderLogo({ provider, sourceName, serverUrl, size = 20 }: ProviderLogoProps) {
  const source = providerSourceLogo(provider, sourceName);
  if (source.viaAppleHealth) {
    const badgeSize = Math.round(size * 0.45);
    return (
      <View style={{ position: "relative", width: size, height: size }} accessibilityElementsHidden>
        <ProviderLogo provider={source.provider} size={size} serverUrl={serverUrl} />
        <Image
          source={{ uri: `${serverUrl}/logos/apple_health.png` }}
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: badgeSize,
            height: badgeSize,
            borderRadius: badgeSize * 0.2,
          }}
        />
      </View>
    );
  }
  provider = source.provider;
  const url = logoUrl(serverUrl, provider);

  if (url) {
    return (
      <View
        style={[styles.logoContainer, { width: size, height: size, borderRadius: size * 0.2 }]}
        accessibilityElementsHidden
      >
        {providerLogoType(provider) === "svg" ? (
          <SvgUri
            uri={url}
            width={size}
            height={size}
            accessibilityElementsHidden
            onError={captureException}
          />
        ) : (
          <Image
            source={{ uri: url }}
            style={{ width: size, height: size }}
            accessibilityElementsHidden
          />
        )}
      </View>
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
  logoContainer: {
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  letterContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    color: "#fff",
    fontWeight: "600",
  },
});
