import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors } from "../theme";
import { Card } from "./Card";
import { QueryStatePanel } from "./QueryStatePanel";

export function SubjectiveTrackingPanel() {
  const date = useTodayQueryDate();
  const utils = trpc.useUtils();
  const checkIn = trpc.subjective.checkIn.useQuery({ date });
  const regions = trpc.subjective.regions.useQuery();
  const injuries = trpc.subjective.injuries.useQuery();
  const [symptomRegionId, setSymptomRegionId] = useState<string | null>(null);
  const [injuryRegionId, setInjuryRegionId] = useState<string | null>(null);
  const [regionPicker, setRegionPicker] = useState<"symptom" | "injury" | null>(null);
  const [kind, setKind] = useState<"soreness" | "stiffness" | "tenderness">("soreness");
  const [score, setScore] = useState(1);
  const [injuryKind, setInjuryKind] = useState<"injury" | "niggle">("niggle");
  const [injurySeverity, setInjurySeverity] = useState(0);
  const [injuryOnsetDate, setInjuryOnsetDate] = useState(date);
  const [injuryResolvedDate, setInjuryResolvedDate] = useState<string | null>(null);
  const [injuryDescription, setInjuryDescription] = useState("");
  const [savedSymptoms, setSavedSymptoms] = useState<
    Array<{ bodyRegionId: string; kind: "soreness" | "stiffness" | "tenderness"; score: number }>
  >([]);
  const initializedCheckInRef = useRef(false);
  const save = trpc.subjective.saveCheckIn.useMutation({
    onSuccess: (result) => {
      setSavedSymptoms(
        result.symptoms.map((symptom) => ({
          bodyRegionId: symptom.body_region_id,
          kind: symptom.kind,
          score: symptom.score,
        })),
      );
      void utils.subjective.checkIn.invalidate({ date });
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.saveCheckIn" }),
  });
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: () => {
      setInjuryDescription("");
      setInjuryOnsetDate(date);
      setInjuryResolvedDate(null);
      void utils.subjective.injuries.invalidate();
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.createInjury" }),
  });

  useEffect(() => {
    if (!checkIn.data || initializedCheckInRef.current) return;
    initializedCheckInRef.current = true;
    setSavedSymptoms(
      checkIn.data.symptoms.map((symptom) => ({
        bodyRegionId: symptom.body_region_id,
        kind: symptom.kind,
        score: symptom.score,
      })),
    );
  }, [checkIn.data]);

  const selectedSymptomLabel = regions.data?.find((region) => region.id === symptomRegionId)?.label;
  const selectedInjuryLabel = regions.data?.find((region) => region.id === injuryRegionId)?.label;
  const checkInReady = checkIn.data !== undefined && !checkIn.error;
  const addSymptom = () => {
    if (!symptomRegionId) return;
    setSavedSymptoms((current) => [
      ...current.filter((item) => !(item.bodyRegionId === symptomRegionId && item.kind === kind)),
      { bodyRegionId: symptomRegionId, kind, score },
    ]);
  };

  return (
    <Card>
      <Text style={styles.title}>Body check-in</Text>
      {checkIn.isLoading && checkIn.data === undefined ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : checkIn.error && checkIn.data === undefined ? (
        <QueryStatePanel variant="error" message={checkIn.error.message} minHeight={96} />
      ) : (
        <Text style={styles.subtitle}>
          {checkIn.data?.logged
            ? savedSymptoms.length === 0
              ? "Logged all clear"
              : "Logged"
            : "Not logged"}
        </Text>
      )}
      <View style={styles.row}>
        {regions.isLoading && regions.data === undefined ? (
          <QueryStatePanel variant="loading" minHeight={56} style={styles.regionState} />
        ) : regions.error && regions.data === undefined ? (
          <QueryStatePanel
            variant="error"
            message={regions.error.message}
            minHeight={80}
            style={styles.regionState}
          />
        ) : (
          <Pressable
            style={styles.control}
            onPress={() => setRegionPicker("symptom")}
            accessibilityLabel="Choose body region"
          >
            <Text style={styles.controlText}>{selectedSymptomLabel ?? "Choose region"}</Text>
          </Pressable>
        )}
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
        <Pressable
          style={styles.secondaryButton}
          onPress={addSymptom}
          disabled={!checkInReady || !symptomRegionId}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Add symptom</Text>
        </Pressable>
        <Pressable
          style={styles.primaryButton}
          onPress={() => save.mutate({ date, symptoms: savedSymptoms })}
          disabled={!checkInReady || save.isPending}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            save.mutate({ date, symptoms: [] });
          }}
          disabled={!checkInReady || save.isPending}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>All clear</Text>
        </Pressable>
      </View>
      {save.error ? <Text style={styles.error}>{save.error.message}</Text> : null}
      <Text style={styles.timelineTitle}>Injuries and niggles</Text>
      <View style={styles.injuryForm}>
        <View style={styles.row}>
          {regions.isLoading && regions.data === undefined ? (
            <QueryStatePanel variant="loading" minHeight={56} style={styles.regionState} />
          ) : regions.error && regions.data === undefined ? (
            <QueryStatePanel
              variant="error"
              message={regions.error.message}
              minHeight={80}
              style={styles.regionState}
            />
          ) : regions.data?.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No body regions are available."
              minHeight={56}
              style={styles.regionState}
            />
          ) : (
            <Pressable
              style={styles.control}
              onPress={() => setRegionPicker("injury")}
              accessibilityLabel="Choose injury body region"
            >
              <Text style={styles.controlText}>{selectedInjuryLabel ?? "Choose region"}</Text>
            </Pressable>
          )}
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
          accessibilityLabel="Injury onset date"
          onChangeText={setInjuryOnsetDate}
          placeholder="Onset date (YYYY-MM-DD)"
          placeholderTextColor={colors.textSecondary}
          style={styles.descriptionInput}
          value={injuryOnsetDate}
        />
        <TextInput
          accessibilityLabel="Injury resolution date"
          onChangeText={(value) => setInjuryResolvedDate(value.trim() === "" ? null : value)}
          placeholder="Resolution date (optional)"
          placeholderTextColor={colors.textSecondary}
          style={styles.descriptionInput}
          value={injuryResolvedDate ?? ""}
        />
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
            if (!injuryRegionId || !injuryDescription.trim() || !injuryOnsetDate.trim()) return;
            createInjury.mutate({
              bodyRegionId: injuryRegionId,
              description: injuryDescription.trim(),
              kind: injuryKind,
              onsetDate: injuryOnsetDate,
              resolvedDate: injuryResolvedDate,
              severity: injurySeverity,
            });
          }}
          disabled={
            !injuryRegionId ||
            !injuryDescription.trim() ||
            !injuryOnsetDate.trim() ||
            createInjury.isPending
          }
          accessibilityRole="button"
          accessibilityLabel="Add injury"
        >
          <Text style={styles.secondaryText}>Add injury</Text>
        </Pressable>
      </View>
      {createInjury.error ? <Text style={styles.error}>{createInjury.error.message}</Text> : null}
      {injuries.isLoading && injuries.data === undefined ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : injuries.error && injuries.data === undefined ? (
        <QueryStatePanel variant="error" message={injuries.error.message} minHeight={96} />
      ) : injuries.data?.length ? (
        injuries.data.map((injury) => (
          <Text key={injury.id} style={styles.injury}>
            {injury.kind}: {injury.description} (
            {injury.severity == null ? "severity not recorded" : `${injury.severity}/10`})
          </Text>
        ))
      ) : (
        <Text style={styles.subtitle}>No injury events logged.</Text>
      )}
      <Modal
        visible={regionPicker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRegionPicker(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.regionPicker}>
            <Text style={styles.timelineTitle}>
              Choose {regionPicker === "injury" ? "injury" : "symptom"} body region
            </Text>
            <ScrollView style={styles.regionOptions}>
              {regions.data?.map((region) => (
                <Pressable
                  key={region.id}
                  style={styles.regionOption}
                  onPress={() => {
                    if (regionPicker === "injury") setInjuryRegionId(region.id);
                    else setSymptomRegionId(region.id);
                    setRegionPicker(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={region.label}
                >
                  <Text style={styles.controlText}>{region.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => setRegionPicker(null)}
              accessibilityRole="button"
              accessibilityLabel="Close region picker"
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  regionState: { flex: 1 },
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
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  regionPicker: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    maxHeight: "80%",
    padding: 16,
    width: "100%",
  },
  regionOptions: { marginVertical: 12 },
  regionOption: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    minHeight: 42,
    justifyContent: "center",
    paddingVertical: 10,
  },
});
