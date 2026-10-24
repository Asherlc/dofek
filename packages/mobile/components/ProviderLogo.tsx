import { garminDeviceThumbnail } from "@dofek/providers/garmin-devices";
import {
  BRAND_COLORS,
  PROVIDER_LABELS,
  providerLogoId,
  providerLogoType,
  providerSourceLogo,
} from "@dofek/providers/providers";
import { useState } from "react";
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

function GarminThumbnail({
  imageUrl,
  sourceName,
  serverUrl,
  size,
}: {
  imageUrl: string;
  sourceName?: string | null;
  serverUrl: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ProviderLogo provider="garmin" serverUrl={serverUrl} size={size} />;
  return (
    <Image
      source={{ uri: imageUrl }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityElementsHidden
      onError={() => {
        setFailed(true);
        captureException(new Error("Unable to load Garmin device thumbnail"), {
          provider: "garmin",
          sourceName,
          imageUrl,
        });
      }}
    />
  );
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
            backgroundColor: "#fff",
            borderWidth: 1,
            borderColor: "#fff",
          }}
        />
      </View>
    );
  }
  provider = source.provider;
  const thumbnail = provider === "garmin" ? garminDeviceThumbnail(sourceName) : null;
  if (thumbnail) {
    return (
      <GarminThumbnail
        key={thumbnail}
        imageUrl={thumbnail}
        sourceName={sourceName}
        serverUrl={serverUrl}
        size={size}
      />
    );
  }
  const url = logoUrl(serverUrl, provider);

  if (url && providerLogoType(provider) === "svg") {
    return (
      <SvgUri
        uri={url}
        width={size}
        height={size}
        accessibilityElementsHidden
        onError={captureException}
      />
    );
  }

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
