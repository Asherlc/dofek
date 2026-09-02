import { PRIMARY_GOAL_OPTIONS, type PrimaryGoal } from "@dofek/onboarding/primary-goal";
import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

/**
 * Storybook-only presentational stand-in for PrimaryGoalSelector.
 * The real component depends on tRPC hooks which aren't available in Storybook.
 */
function PrimaryGoalSelectorPreview({ initialGoal }: { initialGoal: PrimaryGoal | null }) {
  const [currentGoal, setCurrentGoal] = useState<PrimaryGoal | null>(initialGoal);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Primary goal</Text>
      <Text style={styles.subtitle}>
        Choose the outcome Dofek should optimize toward. You can change this anytime.
      </Text>
      <View style={styles.optionsContainer}>
        {PRIMARY_GOAL_OPTIONS.map((option) => {
          const isSelected = currentGoal === option.id;
          return (
            <TouchableOpacity
              key={option.id}
              style={[styles.option, isSelected && styles.optionSelected]}
              onPress={() => setCurrentGoal(option.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
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

const meta = {
  title: "Settings/PrimaryGoalSelector",
  component: PrimaryGoalSelectorPreview,
} satisfies Meta<typeof PrimaryGoalSelectorPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Unselected: Story = {
  args: { initialGoal: null },
};

export const SleepConsistency: Story = {
  args: { initialGoal: "sleepConsistency" },
};

export const RacePreparation: Story = {
  args: { initialGoal: "racePreparation" },
};

const styles = StyleSheet.create({
  container: {
    gap: 8,
    padding: 16,
    width: 360,
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
    borderColor: colors.accent,
    backgroundColor: "rgba(59, 130, 246, 0.1)",
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  optionLabelSelected: {
    color: colors.accent,
  },
  optionDescription: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
