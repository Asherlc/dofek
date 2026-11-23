import { formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import type { LoggedSetComparison } from "dofek-server/types";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import {
  type StrengthProgressionRow,
  strengthEvidenceSummary,
  strengthHeadline,
} from "../lib/training-progression";
import { colors } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard";
export function StrengthLoggedSetComparison({
  data,
  loading = false,
  error,
  units,
  progressionRows,
}: {
  data?: LoggedSetComparison;
  loading?: boolean;
  error?: { message: string } | null;
  units: UnitConverter;
  progressionRows?: StrengthProgressionRow[];
}) {
  const [exerciseKey, setExerciseKey] = useState<string | null>(null);
  const [reps, setReps] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const exercise =
    data?.exercises.find((item) => item.exerciseId === exerciseKey) ?? data?.exercises[0];
  const progressionRow = progressionRows?.find((row) => row.exerciseId === exercise?.exerciseId);
  const comparison =
    exercise?.comparisons.find((item) => item.reps === reps) ?? exercise?.comparisons[0];
  const weight = (value: number) => formatMeasurementText(units.formatWeight(value));
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        Sets and performance
      </Text>
      {error ? <QueryStatePanel variant="error" message={error.message} /> : null}
      {!data && loading ? <QueryStatePanel variant="loading" /> : null}
      {!loading && !error && !exercise ? (
        <QueryStatePanel
          variant="empty"
          message="No logged sets with load and reps in this period"
        />
      ) : null}
      {exercise ? (
        <>
          <View style={styles.choices}>
            {data?.exercises.map((item) => (
              <Pressable
                key={item.exerciseId}
                accessibilityRole="button"
                accessibilityState={{ selected: item === exercise }}
                onPress={() => {
                  setExerciseKey(item.exerciseId);
                  setReps(null);
                }}
                style={[styles.button, styles.option, item === exercise && styles.selectedOption]}
              >
                <Text style={[styles.text, item === exercise && styles.selectedText]}>
                  {item.exerciseName}
                  {item.equipment ? ` · ${item.equipment}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
          {progressionRow ? (
            <TrainingProgressionStatusCard
              status={progressionRow.status}
              headline={strengthHeadline(progressionRow)}
              summary={strengthEvidenceSummary(progressionRow)}
              details={<StrengthProgressionEvidence row={progressionRow} units={units} />}
            />
          ) : null}
          {exercise.comparisons.length > 1 ? (
            <View style={styles.choices}>
              {exercise.comparisons.map((item) => (
                <Pressable
                  key={item.reps}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item === comparison }}
                  onPress={() => setReps(item.reps)}
                  style={[
                    styles.button,
                    styles.option,
                    item === comparison && styles.selectedOption,
                  ]}
                >
                  <Text style={[styles.text, item === comparison && styles.selectedText]}>
                    {item.reps} reps
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.choices}>
            <View style={styles.summary}>
              <Text style={styles.text}>Logged sets with load and reps</Text>
              <Text style={styles.value}>{exercise.totalLoggedSets}</Text>
              <Text style={styles.meta}>Across {exercise.sessions.length} recorded sessions</Text>
            </View>
            {comparison ? (
              <View style={styles.summary}>
                <Text style={styles.text}>Heaviest set of {comparison.reps} reps</Text>
                <Text style={styles.value}>
                  {weight(comparison.first.weightKg)}
                  {comparison.latest ? ` → ${weight(comparison.latest.weightKg)}` : ""}
                </Text>
                <Text style={styles.meta}>
                  {formatDateMedium(comparison.first.date, { timeZone: "UTC" })}
                  {comparison.latest
                    ? ` to ${formatDateMedium(comparison.latest.date, { timeZone: "UTC" })}`
                    : " · One recorded date"}
                </Text>
              </View>
            ) : null}
          </View>
          {exercise.sessions.map((session) => {
            const observed = session.heaviestSets.find((item) => item.reps === comparison?.reps);
            return (
              <View key={session.activityId} style={styles.row}>
                <Text style={styles.text}>
                  {formatDateMedium(session.date, { timeZone: "UTC" })} · {session.loggedSets}{" "}
                  logged sets
                </Text>
                <Text style={styles.text}>
                  {observed
                    ? weight(observed.weightKg)
                    : comparison
                      ? `No ${comparison.reps}-rep set`
                      : "No comparable rep observation"}
                </Text>
                <Text style={styles.meta}>
                  {session.sourceProviders.map(providerLabel).join(", ")}
                </Text>
              </View>
            );
          })}
        </>
      ) : null}
      {data ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={styles.button}
          >
            <Text style={styles.link}>About this comparison</Text>
          </Pressable>
          {expanded ? (
            <>
              <Text style={styles.meta}>{data.research.summary}</Text>
              <Pressable
                accessibilityRole="link"
                onPress={() =>
                  void openExternalUrl(data.research.url, "StrengthLoggedSetComparison")
                }
                style={styles.button}
              >
                <Text style={styles.link}>Read the study</Text>
              </Pressable>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 16, gap: 12, backgroundColor: colors.surface, borderRadius: 12 },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  text: { color: colors.text, fontSize: 14 },
  meta: { color: colors.textSecondary, fontSize: 12 },
  value: { color: colors.text, fontSize: 22, fontWeight: "600" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  summary: { flex: 1, minWidth: 130, gap: 4 },
  button: { minHeight: 44, justifyContent: "center" },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    maxWidth: "100%",
  },
  selectedOption: { borderColor: colors.accent },
  selectedText: { color: colors.accent, fontWeight: "600" },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  link: { color: colors.accent },
});
