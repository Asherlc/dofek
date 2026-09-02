import { GET_STARTED_STEPS } from "@dofek/onboarding/get-started-flow";
import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { PrimaryGoalSelector } from "../components/PrimaryGoalSelector";
import { colors } from "../theme";

export default function OnboardingScreen() {
  const router = useRouter();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>First-run setup</Text>
        <Text style={styles.title}>Set up Dofek with your real data</Text>
        <Text style={styles.subtitle}>
          Dofek is useful after it has data to work with. Start by choosing a primary goal,
          connecting the sources you already use, then open the dashboard when sync has something to
          show.
        </Text>
      </View>

      <View style={styles.goalCard}>
        <PrimaryGoalSelector />
      </View>

      <View style={styles.stepList}>
        {GET_STARTED_STEPS.map((step, stepIndex) => (
          <View key={step.id} style={styles.stepCard}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepBadgeText}>{stepIndex + 1}</Text>
            </View>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDescription}>{step.description}</Text>
            <TouchableOpacity
              style={styles.stepButton}
              onPress={() => router.push(step.mobilePath)}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={step.actionLabel}
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
    gap: 16,
  },
  header: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 22,
    gap: 12,
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
    lineHeight: 36,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  goalCard: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    padding: 18,
  },
  stepList: {
    gap: 12,
  },
  stepCard: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
    minHeight: 220,
    padding: 18,
  },
  stepBadge: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  stepBadgeText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  stepTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  stepDescription: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  stepButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    marginTop: "auto",
    minHeight: 46,
    padding: 12,
  },
  stepButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
