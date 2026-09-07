import { formatMeasurementText, UnitConverter } from "@dofek/format/units";
import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type UnitSystem = "metric" | "imperial";

const KG_TO_LBS = 2.20462;

export function GoalWeightSettingsSection({ unitSystem }: { unitSystem: UnitSystem }) {
  const trpcUtils = trpc.useUtils();
  const goalWeightSetting = trpc.settings.get.useQuery({ key: "goalWeight" });
  const goalWeightMutation = trpc.bodyAnalytics.setGoalWeight.useMutation({
    onSuccess: () => {
      void goalWeightSetting.refetch();
      void trpcUtils.bodyAnalytics.weightPrediction.invalidate();
    },
  });
  const currentGoalKg =
    goalWeightSetting.data?.value != null ? Number(goalWeightSetting.data.value) : null;
  const [goalInput, setGoalInput] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const isImperial = unitSystem === "imperial";
  const units = new UnitConverter(unitSystem);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Goal Weight</Text>
      <Text style={styles.sectionDescription}>
        Set a target weight to see projected completion dates
      </Text>
      <View style={styles.card}>
        {editingGoal ? (
          <View style={styles.goalEditRow}>
            <TextInput
              style={styles.goalInput}
              value={goalInput}
              onChangeText={setGoalInput}
              keyboardType="decimal-pad"
              placeholder={isImperial ? "lbs" : "kg"}
              placeholderTextColor={colors.textSecondary}
            />
            <TouchableOpacity
              style={styles.goalSaveButton}
              onPress={() => {
                const parsed = Number.parseFloat(goalInput);
                if (!Number.isNaN(parsed) && parsed > 0) {
                  const weightKg = isImperial ? parsed / KG_TO_LBS : parsed;
                  goalWeightMutation.mutate({ weightKg });
                }
                setEditingGoal(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="Save goal weight"
              accessibilityState={{ busy: goalWeightMutation.isPending }}
            >
              <Text style={styles.goalSaveText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setEditingGoal(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel goal weight edit"
            >
              <Text style={styles.goalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : currentGoalKg != null ? (
          <View style={styles.goalDisplayRow}>
            <Text style={styles.goalDisplayText}>
              {formatMeasurementText(units.formatWeight(currentGoalKg))}
            </Text>
            <TouchableOpacity
              onPress={() => {
                setGoalInput(
                  String(
                    Math.round((isImperial ? currentGoalKg * KG_TO_LBS : currentGoalKg) * 10) / 10,
                  ),
                );
                setEditingGoal(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Edit goal weight"
            >
              <Text style={styles.goalEditText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => goalWeightMutation.mutate({ weightKg: null })}
              accessibilityRole="button"
              accessibilityLabel="Clear goal weight"
              accessibilityState={{ busy: goalWeightMutation.isPending }}
            >
              <Text style={styles.goalCancelText}>Clear</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => {
              setGoalInput("");
              setEditingGoal(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Set Goal Weight"
          >
            <Text style={styles.goalEditText}>Set Goal Weight</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
  },
  goalEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  goalInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 14,
  },
  goalSaveButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goalSaveText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },
  goalCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    paddingHorizontal: 8,
  },
  goalDisplayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  goalDisplayText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  goalEditText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },
});
