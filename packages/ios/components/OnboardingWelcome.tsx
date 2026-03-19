import { ONBOARDING_CATEGORIES } from "@dofek/shared/onboarding";
import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

interface ProviderInfo {
  id: string;
  name: string;
  authorized: boolean;
}

interface OnboardingWelcomeProps {
  onDismiss: () => void;
  providers: ProviderInfo[];
}

/** Readable label for a provider ID */
function providerDisplayName(id: string): string {
  const labels: Record<string, string> = {
    strava: "Strava",
    garmin: "Garmin",
    wahoo: "Wahoo",
    polar: "Polar",
    fitbit: "Fitbit",
    zwift: "Zwift",
    peloton: "Peloton",
    suunto: "Suunto",
    coros: "COROS",
    oura: "Oura",
    whoop: "WHOOP",
    "eight-sleep": "Eight Sleep",
    "cronometer-csv": "Cronometer",
    fatsecret: "FatSecret",
    withings: "Withings",
    ultrahuman: "Ultrahuman",
    trainerroad: "TrainerRoad",
    concept2: "Concept2",
    komoot: "Komoot",
    "ride-with-gps": "Ride with GPS",
    mapmyfitness: "MapMyFitness",
    cycling_analytics: "Cycling Analytics",
    xert: "Xert",
    velohero: "VeloHero",
    decathlon: "Decathlon",
    wger: "Wger",
  };
  return labels[id] ?? id;
}

export function OnboardingWelcome({ onDismiss, providers }: OnboardingWelcomeProps) {
  const router = useRouter();
  const availableProviderIds = new Set(providers.map((p) => p.id));

  return (
    <View style={styles.container} testID="onboarding-welcome">
      {/* Welcome header */}
      <View style={styles.header}>
        <Text style={styles.title}>Welcome to Dofek</Text>
        <Text style={styles.subtitle}>
          Connect your health and fitness accounts to unlock personalized insights, recovery
          tracking, training analysis, and more.
        </Text>
      </View>

      {/* Category cards */}
      {ONBOARDING_CATEGORIES.map((category) => {
        const categoryProviders = category.providerIds.filter((id) =>
          availableProviderIds.has(id),
        );
        if (categoryProviders.length === 0) return null;

        return (
          <View key={category.title} style={styles.card}>
            <Text style={styles.cardTitle}>{category.title}</Text>
            <Text style={styles.cardDescription}>{category.description}</Text>
            <View style={styles.providerRow}>
              {categoryProviders.slice(0, 4).map((providerId) => (
                <Text key={providerId} style={styles.providerChip}>
                  {providerDisplayName(providerId)}
                </Text>
              ))}
              {categoryProviders.length > 4 && (
                <Text style={styles.moreText}>+{categoryProviders.length - 4} more</Text>
              )}
            </View>
          </View>
        );
      })}

      {/* Actions */}
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => router.push("/providers")}
        activeOpacity={0.7}
      >
        <Text style={styles.primaryButtonText}>Set up data sources</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={onDismiss} activeOpacity={0.7}>
        <Text style={styles.skipText}>Skip for now</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  header: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  providerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  providerChip: {
    fontSize: 12,
    color: colors.accent,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    overflow: "hidden",
  },
  moreText: {
    fontSize: 12,
    color: colors.textTertiary,
    alignSelf: "center",
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
  },
  skipText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 8,
  },
});
