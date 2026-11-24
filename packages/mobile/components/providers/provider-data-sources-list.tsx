import {
  groupProviderEntries,
  PROVIDER_DATA_SOURCE_TABS,
  type ProviderDataSourceCategory,
  providerFamily,
} from "@dofek/providers/provider-catalog";
import { type ReactNode, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../QueryStatePanel";
import { ScreenSections } from "../ScreenSections";
import type { Provider } from "./provider-card.tsx";
import { styles } from "./styles.ts";

const activitySections = PROVIDER_DATA_SOURCE_TABS.map((tab) => ({
  id: tab.id,
  title: tab.label,
}));

export function ProviderDataSourcesList({
  providers,
  providersError,
  statsError,
  isLoading,
  renderProviderCard,
}: {
  providers: readonly Provider[];
  providersError: unknown;
  statsError: unknown;
  isLoading: boolean;
  renderProviderCard: (provider: Provider) => ReactNode;
}) {
  const [activityCategory, setActivityCategory] = useState<ProviderDataSourceCategory>("all");
  const [selectedFamilyMethods, setSelectedFamilyMethods] = useState<Record<string, string>>({});
  const providerGroups = groupProviderEntries(providers, activityCategory);

  return (
    <View>
      <Text style={styles.sectionTitle}>Data Sources</Text>
      {providersError ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title="Could not load data sources"
            message={getQueryErrorMessage(providersError, "Failed to load providers.")}
          />
        </View>
      ) : null}
      {statsError ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title="Could not load provider stats"
            message={getQueryErrorMessage(statsError, "Failed to load provider stats.")}
          />
        </View>
      ) : null}
      {isLoading && !providersError ? (
        <QueryStatePanel variant="loading" style={styles.card} />
      ) : null}
      <ScreenSections
        label="Activity types"
        sections={activitySections}
        selected={activityCategory}
        onSelect={setActivityCategory}
      />
      {providerGroups.map((group) => {
        if (group.kind === "provider") {
          return <View key={group.provider.id}>{renderProviderCard(group.provider)}</View>;
        }
        const selectedProviderId = selectedFamilyMethods[group.family.id] ?? group.providers[0].id;
        const selectedProvider =
          group.providers.find((provider) => provider.id === selectedProviderId) ??
          group.providers[0];
        return (
          <View key={group.family.id} testID={`provider-family-${group.family.id}`}>
            <View style={styles.providerFamilyHeader}>
              <Text style={styles.providerFamilyTitle}>{group.family.label}</Text>
              <View style={styles.providerFamilyMethods}>
                {group.providers.map((provider) => {
                  const methodLabel = providerFamily(provider.id)?.methodLabel ?? provider.label;
                  const selected = provider.id === selectedProvider.id;
                  return (
                    <TouchableOpacity
                      key={provider.id}
                      style={[
                        styles.providerFamilyMethod,
                        selected && styles.providerFamilyMethodSelected,
                      ]}
                      onPress={() =>
                        setSelectedFamilyMethods((current) => ({
                          ...current,
                          [group.family.id]: provider.id,
                        }))
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Select ${group.family.label} ${methodLabel}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={styles.providerFamilyMethodText}>{methodLabel}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            {renderProviderCard(selectedProvider)}
          </View>
        );
      })}
    </View>
  );
}
