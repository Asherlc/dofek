import {
  PRIMARY_GOAL_OPTIONS,
  PRIMARY_GOAL_SETTINGS_KEY,
  type PrimaryGoal,
  parsePrimaryGoal,
} from "@dofek/onboarding/primary-goal";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function PrimaryGoalSelector({ showHeading = true }: { showHeading?: boolean }) {
  const setting = trpc.settings.get.useQuery({ key: PRIMARY_GOAL_SETTINGS_KEY });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastReadError = useRef<unknown>(null);
  const currentGoal = parsePrimaryGoal(setting.data?.value);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "primary-goal-read" });
    }
  }, [setting.error]);

  const handleChange = (goal: PrimaryGoal) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: PRIMARY_GOAL_SETTINGS_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: PRIMARY_GOAL_SETTINGS_KEY },
      { key: PRIMARY_GOAL_SETTINGS_KEY, value: goal },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: PRIMARY_GOAL_SETTINGS_KEY, value: goal },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key: PRIMARY_GOAL_SETTINGS_KEY }, previousSetting);
          setWriteError(error.message);
          captureException(error, { context: "primary-goal-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: PRIMARY_GOAL_SETTINGS_KEY });
        },
      },
    );
  };

  return (
    <View style={styles.container}>
      {showHeading ? (
        <>
          <Text style={styles.title}>Primary goal</Text>
          <Text style={styles.subtitle}>
            Choose the outcome Dofek should optimize toward. You can change this anytime.
          </Text>
        </>
      ) : null}
      {(writeError ?? setting.error?.message) && (
        <Text style={styles.errorText}>{writeError ?? setting.error?.message}</Text>
      )}
      <View style={styles.optionsContainer}>
        {PRIMARY_GOAL_OPTIONS.map((option) => {
          const isSelected = currentGoal === option.id;
          return (
            <TouchableOpacity
              key={option.id}
              style={[styles.option, isSelected && styles.optionSelected]}
              onPress={() => handleChange(option.id)}
              activeOpacity={0.7}
              disabled={setSettingMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={`${option.label}, ${option.description}`}
              accessibilityState={{
                busy: setSettingMutation.isPending,
                disabled: setSettingMutation.isPending,
                selected: isSelected,
              }}
            >
              <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                {option.label}
              </Text>
              <Text style={styles.optionDescription}>{option.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
  errorText: {
    color: colors.negative,
    fontSize: 13,
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
    borderColor: colors.accent,
    backgroundColor: colors.accentSubtle,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  optionLabelSelected: {
    color: colors.text,
  },
  optionDescription: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
