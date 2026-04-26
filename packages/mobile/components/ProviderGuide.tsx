import { PROVIDER_GUIDE_CATEGORIES } from "@dofek/onboarding/provider-guide";
import { providerLabel } from "@dofek/providers/providers";
import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

interface ProviderInfo {
  id: string;
  name: string;
  authorized: boolean;
}

interface ProviderGuideProps {
  onDismiss: () => void;
  providers: ProviderInfo[];
}

export function ProviderGuide({ onDismiss, providers }: ProviderGuideProps) {
  const router = useRouter();
  const availableProviderIds = new Set(providers.map((provider) => provider.id));

  return (
    <View style={styles.container} testID="provider-guide">
      {/* Welcome header */}
      <View style={styles.header}>
        <Text style={styles.title}>Welcome to Dofek</Text>
        <Text style={styles.subtitle}>
          Connect your health and fitness accounts to unlock personalized insights, recovery
          tracking, training analysis, and more.
        </Text>
      </View>

      {/* Category cards */}
      {PROVIDER_GUIDE_CATEGORIES.map((category) => {
        const categoryProviders = category.providerIds.filter((id) => availableProviderIds.has(id));
        if (categoryProviders.length === 0) return null;

        return (
          <View key={category.title} style={styles.card}>
            <Text style={styles.cardTitle}>{category.title}</Text>
            <Text style={styles.cardDescription}>{category.description}</Text>
            <View style={styles.providerRow}>
              {categoryProviders.slice(0, 4).map((providerId) => (
                <Text key={providerId} style={styles.providerChip}>
                  {providerLabel(providerId)}
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
    backgroundColor: colors.accent,
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
