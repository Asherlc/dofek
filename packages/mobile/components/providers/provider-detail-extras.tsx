import {
  parseWhoopWearLocation,
  WHOOP_WEAR_LOCATION_SETTING_KEY,
  WHOOP_WEAR_LOCATIONS,
  type WhoopWearLocation,
} from "@dofek/providers/whoop";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

export function ProviderDetailExtras({ providerId }: { providerId: string }) {
  if (providerId === "whoop") {
    return <WhoopWearLocationPicker />;
  }

  return null;
}

function WhoopWearLocationPicker() {
  const setting = trpc.settings.get.useQuery({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastReadError = useRef<unknown>(null);

  const currentLocation = parseWhoopWearLocation(setting.data?.value);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "whoop-wear-location-read" });
    }
  }, [setting.error]);

  const handleChange = (location: WhoopWearLocation) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: WHOOP_WEAR_LOCATION_SETTING_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY },
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key: WHOOP_WEAR_LOCATION_SETTING_KEY }, previousSetting);
          setWriteError(error.message);
          captureException(error, { context: "whoop-wear-location-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
        },
      },
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Wear Location</Text>
      <Text style={styles.subtitle}>
        Where do you wear your WHOOP? This helps us interpret your sensor data.
      </Text>
      {(writeError ?? setting.error?.message) && (
        <Text style={styles.errorText}>{writeError ?? setting.error?.message}</Text>
      )}
      <View style={styles.optionsContainer}>
        {WHOOP_WEAR_LOCATIONS.map((location) => {
          const isSelected = currentLocation === location.id;
          return (
            <TouchableOpacity
              key={location.id}
              style={[styles.option, isSelected && styles.optionSelected]}
              onPress={() => handleChange(location.id)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${location.label}, ${location.description}`}
              accessibilityState={{ selected: isSelected }}
            >
              <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                {location.label}
              </Text>
              <Text style={styles.optionDescription}>{location.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  optionsContainer: {
    gap: 8,
    marginTop: 4,
  },
  option: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  optionSelected: {
    borderColor: colors.positive,
    backgroundColor: "rgba(52, 211, 153, 0.1)",
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  optionLabelSelected: {
    color: colors.positive,
  },
  optionDescription: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
  },
});
