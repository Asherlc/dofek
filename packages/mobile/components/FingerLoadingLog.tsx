import { UnitConverter, type UnitSystem } from "@dofek/format/units";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type FingerExercise = "max_hang" | "repeater" | "min_edge" | "one_arm" | "campus" | "no_hang";
type GripPosition =
  | "half_crimp"
  | "full_crimp"
  | "open_hand"
  | "three_finger_drag"
  | "two_finger_pocket";
type Laterality = "both" | "left" | "right";

export interface FingerLoadingSubmission {
  bodyweightKg: number;
  edgeSizeMm: number | null;
  exercise: FingerExercise;
  externalLoadKg: number;
  gripPosition: GripPosition | null;
  holdDurationSeconds: number;
  laterality: Laterality;
  notes: string | null;
  restIntervalSeconds: number;
  setCount: number;
  startedAt: string;
}

export type FingerLoadingPreset = Omit<FingerLoadingSubmission, "startedAt">;

const exerciseOptions: Array<{ label: string; value: FingerExercise }> = [
  { label: "Max hang", value: "max_hang" },
  { label: "Repeater", value: "repeater" },
  { label: "Minimum edge", value: "min_edge" },
  { label: "One arm", value: "one_arm" },
  { label: "Campus", value: "campus" },
  { label: "No hang", value: "no_hang" },
];
const gripOptions: Array<{ label: string; value: GripPosition }> = [
  { label: "Half crimp", value: "half_crimp" },
  { label: "Full crimp", value: "full_crimp" },
  { label: "Open hand", value: "open_hand" },
  { label: "Three-finger drag", value: "three_finger_drag" },
  { label: "Two-finger pocket", value: "two_finger_pocket" },
];

export function FingerLoadingLog({
  errorMessage,
  latest,
  loading,
  onSubmit,
  submitting,
  unitSystem,
}: {
  errorMessage: string | null;
  latest: FingerLoadingPreset | null;
  loading: boolean;
  onSubmit: (input: FingerLoadingSubmission) => void;
  submitting: boolean;
  unitSystem: UnitSystem;
}) {
  const units = new UnitConverter(unitSystem);
  const [exercise, setExercise] = useState<FingerExercise>("max_hang");
  const [edgeSize, setEdgeSize] = useState("20");
  const [gripPosition, setGripPosition] = useState<GripPosition>("half_crimp");
  const [bodyweight, setBodyweight] = useState("70");
  const [externalLoad, setExternalLoad] = useState("0");
  const [laterality, setLaterality] = useState<Laterality>("both");
  const [setCount, setSetCount] = useState("5");
  const [holdDuration, setHoldDuration] = useState("10");
  const [restInterval, setRestInterval] = useState("180");
  const [notes, setNotes] = useState("");

  function applyPreset(preset: FingerLoadingPreset): void {
    setExercise(preset.exercise);
    setEdgeSize(String(preset.edgeSizeMm ?? 20));
    setGripPosition(preset.gripPosition ?? "half_crimp");
    setBodyweight(String(Math.round(units.convertWeight(preset.bodyweightKg) * 10) / 10));
    setExternalLoad(String(Math.round(units.convertWeight(preset.externalLoadKg) * 10) / 10));
    setLaterality(preset.laterality);
    setSetCount(String(preset.setCount));
    setHoldDuration(String(preset.holdDurationSeconds));
    setRestInterval(String(preset.restIntervalSeconds));
    setNotes(preset.notes ?? "");
  }

  const weightToKg = (value: string): number => {
    const parsed = Number(value);
    return unitSystem === "imperial" ? parsed / 2.20462 : parsed;
  };

  if (loading) return <Text style={styles.muted}>Loading previous finger session…</Text>;

  return (
    <View style={styles.card}>
      <Text style={styles.description}>
        Effective load is calculated on the server from bodyweight and external load.
      </Text>
      <OptionGroup
        label="Exercise"
        onSelect={setExercise}
        options={exerciseOptions}
        selected={exercise}
      />
      <OptionGroup
        label="Grip position"
        onSelect={setGripPosition}
        options={gripOptions}
        selected={gripPosition}
      />
      <OptionGroup
        label="Laterality"
        onSelect={setLaterality}
        options={[
          { label: "Both", value: "both" },
          { label: "Left", value: "left" },
          { label: "Right", value: "right" },
        ]}
        selected={laterality}
      />
      <View style={styles.grid}>
        <Input label="Edge size (mm)" onChangeText={setEdgeSize} value={edgeSize} />
        <Input
          label={`Bodyweight (${units.weightLabel})`}
          onChangeText={setBodyweight}
          value={bodyweight}
        />
        <Input
          label={`Added (+) or removed (-) load (${units.weightLabel})`}
          onChangeText={setExternalLoad}
          value={externalLoad}
        />
        <Input label="Sets" onChangeText={setSetCount} value={setCount} />
        <Input
          label="Hold duration (seconds)"
          onChangeText={setHoldDuration}
          value={holdDuration}
        />
        <Input
          label="Rest interval (seconds)"
          onChangeText={setRestInterval}
          value={restInterval}
        />
        <Input label="Notes" onChangeText={setNotes} value={notes} />
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="Repeat previous finger session"
          accessibilityRole="button"
          accessibilityState={{ disabled: latest === null }}
          disabled={latest === null}
          onPress={() => latest && applyPreset(latest)}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryText}>Repeat previous</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Save finger session"
          accessibilityRole="button"
          accessibilityState={{ busy: submitting }}
          disabled={submitting}
          onPress={() =>
            onSubmit({
              bodyweightKg: weightToKg(bodyweight),
              edgeSizeMm: Number(edgeSize),
              exercise,
              externalLoadKg: weightToKg(externalLoad),
              gripPosition,
              holdDurationSeconds: Number(holdDuration),
              laterality,
              notes: notes.trim() || null,
              restIntervalSeconds: Number(restInterval),
              setCount: Number(setCount),
              startedAt: new Date().toISOString(),
            })
          }
          style={styles.primaryButton}
        >
          <Text style={styles.primaryText}>{submitting ? "Saving…" : "Save finger session"}</Text>
        </Pressable>
      </View>
      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

function Input({
  label,
  onChangeText,
  value,
}: {
  label: string;
  onChangeText: (value: string) => void;
  value: string;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardType={label === "Notes" ? "default" : "decimal-pad"}
        onChangeText={onChangeText}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

function OptionGroup<T extends string>({
  label,
  onSelect,
  options,
  selected,
}: {
  label: string;
  onSelect: (value: T) => void;
  options: Array<{ label: string; value: T }>;
  selected: T;
}) {
  return (
    <View style={styles.optionGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.optionRow}>
        {options.map((option) => (
          <Pressable
            accessibilityLabel={`${label} ${option.label}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: option.value === selected }}
            key={option.value}
            onPress={() => onSelect(option.value)}
            style={[styles.option, option.value === selected && styles.optionSelected]}
          >
            <Text style={styles.optionText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md },
  description: { color: colors.textSecondary, marginBottom: spacing.md },
  error: { color: colors.danger, marginTop: spacing.sm },
  grid: { gap: spacing.sm },
  input: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  inputGroup: { flex: 1, gap: spacing.xs },
  label: { color: colors.textSecondary, fontSize: 12 },
  muted: { color: colors.textSecondary },
  option: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  optionGroup: { gap: spacing.xs, marginBottom: spacing.sm },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  optionSelected: { borderColor: colors.blue },
  optionText: { color: colors.text, fontSize: 12 },
  primaryButton: {
    backgroundColor: colors.blue,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  primaryText: { color: colors.background, fontWeight: "600" },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryText: { color: colors.text },
});
