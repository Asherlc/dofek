import {
  GET_STARTED_GOALS,
  GET_STARTED_STEPS,
  type GetStartedGoalId,
} from "@dofek/onboarding/get-started-flow";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export default function OnboardingScreen() {
  const router = useRouter();
  const [selectedGoalId, setSelectedGoalId] = useState<GetStartedGoalId>(GET_STARTED_GOALS[0].id);
  const selectedGoal = GET_STARTED_GOALS.find((goal) => goal.id === selectedGoalId);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Get started</Text>
        <Text style={styles.title}>Set up Dofek</Text>
        <Text style={styles.subtitle}>
          Choose the first question you want to answer, connect the sources that matter, then open
          the dashboard when the first useful signal is ready.
        </Text>
        {selectedGoal ? (
          <Text style={styles.selectedText}>Selected: {selectedGoal.title}</Text>
        ) : null}
      </View>

      <View style={styles.goalGrid}>
        {GET_STARTED_GOALS.map((goal) => {
          const selected = goal.id === selectedGoalId;
          return (
            <TouchableOpacity
              key={goal.id}
              style={[styles.goalCard, selected ? styles.selectedGoalCard : null]}
              onPress={() => setSelectedGoalId(goal.id)}
              activeOpacity={0.75}
            >
              <Text style={styles.goalTitle}>{goal.title}</Text>
              <Text style={styles.goalDescription}>{goal.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.stepList}>
        {GET_STARTED_STEPS.map((step, stepIndex) => (
          <View key={step.id} style={styles.stepCard}>
            <Text style={styles.stepNumber}>Step {stepIndex + 1}</Text>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDescription}>{step.description}</Text>
            <TouchableOpacity
              style={styles.stepButton}
              onPress={() => router.push(step.mobilePath)}
              activeOpacity={0.75}
            >
              <Text style={styles.stepButtonText}>{step.actionLabel}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 20,
    gap: 14,
  },
  header: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  kicker: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  title: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  selectedText: {
    color: colors.text,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontWeight: "600",
  },
  goalGrid: {
    gap: 10,
  },
  goalCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    padding: 16,
    gap: 7,
  },
  selectedGoalCard: {
    borderColor: colors.accent,
  },
  goalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  goalDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  stepList: {
    gap: 10,
  },
  stepCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  stepNumber: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  stepTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  stepDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  stepButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    marginTop: 4,
    padding: 12,
  },
  stepButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
