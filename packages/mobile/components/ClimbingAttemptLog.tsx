import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type FailureReason = "fell" | "pumped" | "skin" | "technique" | "fear";
type HoldType = "crimp" | "sloper" | "pinch" | "pocket" | "jug";
interface AttemptDraft {
  failureReason: FailureReason | null;
  outcome: "sent" | "failed";
}

export interface ClimbingSessionSubmission {
  climbs: Array<{
    attempts: Array<{
      failureReason: FailureReason | null;
      notes: null;
      outcome: "sent" | "failed";
    }>;
    climbType: "boulder" | "route";
    grade: string;
    gradeSystem: "v_scale" | "yds";
    holdType: HoldType;
    routeName: string | null;
    wallAngleDegrees: number;
  }>;
  endedAt: null;
  locationName: string | null;
  startedAt: string;
}

export function ClimbingAttemptLog({
  errorMessage,
  onSubmit,
  submitting,
}: {
  errorMessage: string | null;
  onSubmit: (input: ClimbingSessionSubmission) => void;
  submitting: boolean;
}) {
  const [climbType, setClimbType] = useState<"boulder" | "route">("boulder");
  const [grade, setGrade] = useState("");
  const [wallAngle, setWallAngle] = useState("0");
  const [holdType, setHoldType] = useState<HoldType>("crimp");
  const [routeName, setRouteName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [attempts, setAttempts] = useState<AttemptDraft[]>([
    { failureReason: "fell", outcome: "failed" },
  ]);

  function updateAttempt(attemptIndex: number, patch: Partial<AttemptDraft>): void {
    setAttempts((current) =>
      current.map((attempt, index) => (index === attemptIndex ? { ...attempt, ...patch } : attempt)),
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.description}>
        Record each attempt so failure reasons stay visible beside sends.
      </Text>
      <OptionGroup
        label="Climb type"
        onSelect={setClimbType}
        options={[
          { label: "Boulder", value: "boulder" },
          { label: "Route", value: "route" },
        ]}
        selected={climbType}
      />
      <Input label="Grade" onChangeText={setGrade} value={grade} />
      <Input label="Wall angle (degrees)" onChangeText={setWallAngle} value={wallAngle} />
      <Input label="Route or problem name" onChangeText={setRouteName} value={routeName} />
      <Input label="Location" onChangeText={setLocationName} value={locationName} />
      <OptionGroup
        label="Primary hold"
        onSelect={setHoldType}
        options={["crimp", "sloper", "pinch", "pocket", "jug"].map((value) => ({
          label: `${value[0]?.toUpperCase()}${value.slice(1)}`,
          value: value as HoldType,
        }))}
        selected={holdType}
      />
      {attempts.map((attempt, attemptIndex) => (
        <View key={attemptIndex} style={styles.attempt}>
          <Text style={styles.attemptTitle}>Attempt {attemptIndex + 1}</Text>
          <OptionGroup
            label={`Attempt ${attemptIndex + 1} outcome`}
            onSelect={(outcome: "sent" | "failed") =>
              updateAttempt(attemptIndex, {
                failureReason: outcome === "sent" ? null : (attempt.failureReason ?? "fell"),
                outcome,
              })
            }
            options={[
              { label: "Failed", value: "failed" },
              { label: "Sent", value: "sent" },
            ]}
            selected={attempt.outcome}
          />
          {attempt.outcome === "failed" ? (
            <OptionGroup
              label={`Attempt ${attemptIndex + 1} reason`}
              onSelect={(failureReason: FailureReason) =>
                updateAttempt(attemptIndex, { failureReason })
              }
              options={["fell", "pumped", "skin", "technique", "fear"].map((value) => ({
                label: `${value[0]?.toUpperCase()}${value.slice(1)}`,
                value: value as FailureReason,
              }))}
              selected={attempt.failureReason ?? "fell"}
            />
          ) : null}
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="Add climbing attempt"
          accessibilityRole="button"
          onPress={() =>
            setAttempts((current) => [
              ...current,
              { failureReason: "fell", outcome: "failed" },
            ])
          }
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryText}>Add attempt</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Save climbing session"
          accessibilityRole="button"
          accessibilityState={{ busy: submitting }}
          disabled={submitting}
          onPress={() =>
            onSubmit({
              climbs: [
                {
                  attempts: attempts.map((attempt) => ({ ...attempt, notes: null })),
                  climbType,
                  grade,
                  gradeSystem: climbType === "boulder" ? "v_scale" : "yds",
                  holdType,
                  routeName: routeName.trim() || null,
                  wallAngleDegrees: Number(wallAngle),
                },
              ],
              endedAt: null,
              locationName: locationName.trim() || null,
              startedAt: new Date().toISOString(),
            })
          }
          style={styles.primaryButton}
        >
          <Text style={styles.primaryText}>{submitting ? "Saving…" : "Save climbing session"}</Text>
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  attempt: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.sm,
    padding: spacing.sm,
  },
  attemptTitle: { color: colors.text, fontWeight: "600", marginBottom: spacing.xs },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md },
  description: { color: colors.textSecondary, marginBottom: spacing.md },
  error: { color: colors.danger, marginTop: spacing.sm },
  input: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  inputGroup: { gap: spacing.xs, marginBottom: spacing.sm },
  label: { color: colors.textSecondary, fontSize: 12 },
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
