import { formatDateMedium, formatDateShort } from "@dofek/format/format";
import { formatMeasurementText, UnitConverter } from "@dofek/format/units";
import {
  isSameStrengthExercise,
  type StrengthExerciseIdentity,
  strengthExerciseDisplayLabels,
  strengthExerciseIdentityKey,
} from "@dofek/training/training";
import type { StrengthExerciseHistoryRow } from "dofek-server/types";
import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";
import { AccessibleChart } from "./AccessibleChart";
import { SparkLine } from "./charts/SparkLine";

const SOURCE_WEIGHT_LABELS = {
  KG: new UnitConverter("metric").weightLabel,
  LBS: new UnitConverter("imperial").weightLabel,
} as const;
const ACSM_POSITION_STAND_URL = "https://pmc.ncbi.nlm.nih.gov/articles/PMC12965823/#T6";

type ExerciseOrderEvidence = NonNullable<StrengthExerciseHistoryRow["exerciseOrder"]>;
type ExerciseOrderSession = ExerciseOrderEvidence["baseline"];

interface EstimatedStrengthCardProps {
  rows: StrengthExerciseHistoryRow[];
  loading: boolean;
  error: string | null;
}

export function EstimatedStrengthCard({ rows, loading, error }: EstimatedStrengthCardProps) {
  const units = useUnitConverter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdentity, setSelectedIdentity] = useState<StrengthExerciseIdentity | null>(null);

  const labels = strengthExerciseDisplayLabels(rows);
  const labelFor = (index: number) => labels[index]?.label ?? rows[index]?.exerciseName ?? "";
  const selectedIndex = selectedIdentity
    ? rows.findIndex((row) => isSameStrengthExercise(row, selectedIdentity))
    : -1;
  const selectedRowIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const selected = rows[selectedRowIndex];
  const selectedLabel = selected ? labelFor(selectedRowIndex) : null;
  const estimate = selected?.estimatedStrength ?? null;

  const normalizedQuery = query.trim().toLowerCase();
  const matchingIndexes = rows
    .map((_, index) => index)
    .filter((index) => labelFor(index).toLowerCase().includes(normalizedQuery));

  const chartRows = (estimate?.history ?? []).map((entry) => ({
    label: formatDateShort(entry.date),
    value: `${units.convertWeight(entry.estimatedMax).toFixed(1)} ${units.weightLabel}`,
  }));
  const chartValues = (estimate?.history ?? []).map((entry) =>
    units.convertWeight(entry.estimatedMax),
  );

  function selectRow(index: number) {
    const row = rows[index];
    if (!row) return;
    setSelectedIdentity({ exerciseName: row.exerciseName, equipment: row.equipment });
    setOpen(false);
    setQuery("");
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Estimated single-rep strength</Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {rows.length > 0 ? `Showing last loaded data. Refresh failed: ${error}` : error}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Exercise: ${selectedLabel ?? ""}`}
            accessibilityState={{ expanded: open }}
            onPress={() => {
              setOpen((current) => !current);
              setQuery("");
            }}
            style={styles.selector}
          >
            <Text style={styles.selectorLabel}>Exercise</Text>
            <Text style={styles.selectorValue} numberOfLines={1}>
              {selectedLabel} {open ? "▴" : "▾"}
            </Text>
          </Pressable>
          {open ? (
            <View style={styles.panel}>
              <TextInput
                accessibilityLabel="Search exercises"
                placeholder="Search exercises"
                placeholderTextColor={colors.textMuted}
                value={query}
                onChangeText={setQuery}
                autoFocus
                style={styles.search}
              />
              {matchingIndexes.length === 0 ? (
                <Text style={styles.muted}>No exercises match “{query}”.</Text>
              ) : (
                <ScrollView
                  style={styles.optionList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {matchingIndexes.map((index) => {
                    const row = rows[index];
                    if (!row) return null;
                    return (
                      <Pressable
                        key={strengthExerciseIdentityKey(row)}
                        accessibilityRole="button"
                        accessibilityLabel={labelFor(index)}
                        accessibilityState={{ selected: index === selectedRowIndex }}
                        onPress={() => selectRow(index)}
                        style={styles.option}
                      >
                        <Text style={styles.optionText}>{labelFor(index)}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
      {selected?.exerciseOrder && selectedLabel ? (
        <OrderCallout
          key={strengthExerciseIdentityKey(selected)}
          label={selectedLabel}
          evidence={selected.exerciseOrder}
        />
      ) : null}
      {estimate ? (
        <>
          <Text style={styles.muted}>
            {estimate.trend.summary}{" "}
            {formatMeasurementText(units.formatWeight(estimate.trend.changeMagnitudeKg))}
          </Text>
          <AccessibleChart
            title="Estimated single-rep strength"
            summary={`${estimate.exerciseName} estimated max`}
            rows={chartRows}
          >
            <SparkLine data={chartValues} height={120} color={colors.accent} />
          </AccessibleChart>
        </>
      ) : rows.length === 0 ? (
        error ? null : (
          <Text style={styles.muted}>
            {loading ? "Loading estimated max…" : "No estimated max data"}
          </Text>
        )
      ) : (
        <Text style={styles.muted}>No estimated max for this lift</Text>
      )}
    </View>
  );
}

function OrderCallout({ label, evidence }: { label: string; evidence: ExerciseOrderEvidence }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const latest = evidence.earlier ?? evidence.baseline;
  const sessions = evidence.earlier ? [evidence.baseline, evidence.earlier] : [evidence.baseline];
  const setNumbers = [
    ...new Set(sessions.flatMap((session) => session.sets.map((set) => set.position))),
  ].sort((a, b) => a - b);
  return (
    <View accessibilityLabel="Exercise order evidence" style={styles.callout}>
      <Text style={styles.calloutText}>
        {label} was logged as exercise {latest.position} on {formatDateMedium(latest.date)} in the
        Crimpd log
        {evidence.earlier
          ? `, earlier than exercise ${evidence.baseline.position} on ${formatDateMedium(evidence.baseline.date)}`
          : ""}
        .
      </Text>
      <Text style={styles.calloutText}>
        If getting stronger at {label} is a priority,{" "}
        {latest.position === 1 ? "keep it first" : "try it first"} after warm-up.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Set details"
        accessibilityState={{ expanded: detailsOpen }}
        onPress={() => setDetailsOpen((current) => !current)}
      >
        <Text style={styles.link}>Set details {detailsOpen ? "▴" : "▾"}</Text>
      </Pressable>
      {detailsOpen ? (
        <View accessibilityRole="summary" accessibilityLabel="Set-number comparison">
          <View style={styles.tableRow}>
            <Text style={styles.cellHeader}>Set</Text>
            {sessions.map((session) => (
              <Text key={session.activityId} style={styles.cellHeader}>
                {formatDateMedium(session.date)} · exercise {session.position}
              </Text>
            ))}
          </View>
          {setNumbers.map((setNumber) => (
            <View key={setNumber} style={styles.tableRow}>
              <Text style={styles.cell}>{setNumber}</Text>
              {sessions.map((session) => (
                <Text key={session.activityId} style={styles.cell}>
                  {formatSetCell(session, setNumber)}
                </Text>
              ))}
            </View>
          ))}
          <Text style={styles.muted}>
            Loads are shown as recorded by Crimpd. Rest and effort may differ between sessions.{" "}
          </Text>
          <Text
            style={styles.link}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(ACSM_POSITION_STAND_URL)}
          >
            ACSM position stand
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function formatSetCell(session: ExerciseOrderSession, setNumber: number): string {
  const set = session.sets.find((candidate) => candidate.position === setNumber);
  if (!set) return "Not recorded";
  return `${set.resistance} ${SOURCE_WEIGHT_LABELS[set.unit]} × ${set.reps}`;
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  title: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  error: { color: colors.warning, fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 12 },
  selector: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  selectorLabel: { color: colors.textMuted, fontSize: 12 },
  selectorValue: { color: colors.text, fontSize: 12, flexShrink: 1 },
  panel: { gap: 6, paddingTop: 6 },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.text,
  },
  option: { paddingVertical: 8, paddingHorizontal: 4 },
  optionList: { maxHeight: 220 },
  optionText: { color: colors.text, fontSize: 13 },
  callout: {
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
  },
  calloutText: { color: colors.text, fontSize: 12 },
  link: { color: colors.accent, fontSize: 12 },
  tableRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  cellHeader: { color: colors.text, fontSize: 11, flex: 1 },
  cell: { color: colors.textMuted, fontSize: 11, flex: 1, fontVariant: ["tabular-nums"] },
});
