import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors } from "../theme";
import { Card } from "./Card";

export function SubjectiveTrackingPanel() {
  const date = useTodayQueryDate();
  const utils = trpc.useUtils();
  const checkIn = trpc.subjective.checkIn.useQuery({ date });
  const regions = trpc.subjective.regions.useQuery();
  const injuries = trpc.subjective.injuries.useQuery();
  const [regionId, setRegionId] = useState("");
  const [kind, setKind] = useState<"soreness" | "stiffness" | "tenderness">("soreness");
  const [score, setScore] = useState(1);
  const [injuryKind, setInjuryKind] = useState<"injury" | "niggle">("niggle");
  const [injurySeverity, setInjurySeverity] = useState(0);
  const [injuryDescription, setInjuryDescription] = useState("");
  const [savedSymptoms, setSavedSymptoms] = useState<
    Array<{ bodyRegionId: string; kind: "soreness" | "stiffness" | "tenderness"; score: number }>
  >([]);
  const save = trpc.subjective.saveCheckIn.useMutation({
    onSuccess: () => {
      void utils.subjective.checkIn.invalidate({ date });
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.saveCheckIn" }),
  });
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: () => {
      setInjuryDescription("");
      void utils.subjective.injuries.invalidate();
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.createInjury" }),
  });

  useEffect(() => {
    if (!checkIn.data) return;
    setSavedSymptoms(
      checkIn.data.symptoms.map((symptom) => ({
        bodyRegionId: symptom.body_region_id,
        kind: symptom.kind,
        score: symptom.score,
      })),
    );
  }, [checkIn.data]);

  const selectedLabel = regions.data?.find((region) => region.id === regionId)?.label;
  const addSymptom = () => {
    if (!regionId) return;
    setSavedSymptoms((current) => [
      ...current.filter((item) => !(item.bodyRegionId === regionId && item.kind === kind)),
      { bodyRegionId: regionId, kind, score },
    ]);
  };

  return (
    <Card>
      <Text style={styles.title}>Body check-in</Text>
      <Text style={styles.subtitle}>
        {checkIn.data?.logged
          ? savedSymptoms.length === 0
            ? "Logged all clear"
            : "Logged"
          : "Not logged"}
      </Text>
      <View style={styles.row}>
        <Pressable
          style={styles.control}
          onPress={() => {
            const options = regions.data ?? [];
            if (options.length === 0) return;
            const currentIndex = options.findIndex((region) => region.id === regionId);
            setRegionId(options[(currentIndex + 1) % options.length]?.id ?? "");
          }}
          accessibilityLabel="Choose body region"
        >
          <Text style={styles.controlText}>{selectedLabel ?? "Choose region"}</Text>
        </Pressable>
        <Pressable
          style={styles.control}
          onPress={() =>
            setKind(
              kind === "soreness" ? "stiffness" : kind === "stiffness" ? "tenderness" : "soreness",
            )
          }
        >
          <Text style={styles.controlText}>{kind}</Text>
        </Pressable>
        <Pressable style={styles.score} onPress={() => setScore(score === 10 ? 1 : score + 1)}>
          <Text style={styles.controlText}>{score}/10</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable style={styles.secondaryButton} onPress={addSymptom} accessibilityRole="button">
          <Text style={styles.secondaryText}>Add symptom</Text>
        </Pressable>
        <Pressable
          style={styles.primaryButton}
          onPress={() => save.mutate({ date, symptoms: savedSymptoms })}
          disabled={save.isPending}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            setSavedSymptoms([]);
            save.mutate({ date, symptoms: [] });
          }}
          disabled={save.isPending}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>All clear</Text>
        </Pressable>
      </View>
      {save.error ? <Text style={styles.error}>{save.error.message}</Text> : null}
      <Text style={styles.timelineTitle}>Injuries and niggles</Text>
      <View style={styles.injuryForm}>
        <View style={styles.row}>
          <Pressable
            style={styles.control}
            onPress={() => setInjuryKind(injuryKind === "niggle" ? "injury" : "niggle")}
            accessibilityLabel="Choose injury type"
          >
            <Text style={styles.controlText}>{injuryKind}</Text>
          </Pressable>
          <Pressable
            style={styles.score}
            onPress={() => setInjurySeverity(injurySeverity === 10 ? 0 : injurySeverity + 1)}
            accessibilityLabel="Choose injury severity"
          >
            <Text style={styles.controlText}>{injurySeverity}/10</Text>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="Injury description"
          onChangeText={setInjuryDescription}
          placeholder="Describe an injury or niggle"
          placeholderTextColor={colors.textSecondary}
          style={styles.descriptionInput}
          value={injuryDescription}
        />
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            if (!regionId || !injuryDescription.trim()) return;
            createInjury.mutate({
              bodyRegionId: regionId,
              description: injuryDescription.trim(),
              kind: injuryKind,
              onsetDate: date,
              resolvedDate: null,
              severity: injurySeverity,
            });
          }}
          disabled={!regionId || !injuryDescription.trim() || createInjury.isPending}
          accessibilityRole="button"
          accessibilityLabel="Add injury"
        >
          <Text style={styles.secondaryText}>Add injury</Text>
        </Pressable>
      </View>
      {createInjury.error ? <Text style={styles.error}>{createInjury.error.message}</Text> : null}
      {injuries.data?.length ? (
        injuries.data.map((injury) => (
          <Text key={injury.id} style={styles.injury}>
            {injury.kind}: {injury.description} ({injury.severity}/10)
          </Text>
        ))
      ) : (
        <Text style={styles.subtitle}>No injury events logged.</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  row: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 12 },
  control: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    flex: 1,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  score: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 38,
    paddingHorizontal: 10,
  },
  controlText: { color: colors.text, fontSize: 12 },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  primaryText: { color: colors.background, fontSize: 12, fontWeight: "700" },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryText: { color: colors.text, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 },
  timelineTitle: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 16 },
  injury: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  injuryForm: { gap: 8, marginTop: 8 },
  descriptionInput: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
