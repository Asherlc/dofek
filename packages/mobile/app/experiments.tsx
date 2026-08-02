import { formatDateYmd } from "@dofek/format/format";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default function ExperimentsScreen() {
  const params = useLocalSearchParams<{
    outcomeMetricId?: string | string[];
    lagDays?: string | string[];
  }>();
  const prefilledOutcomeMetricId = firstParam(params.outcomeMetricId);
  const prefilledLagDays = Number(firstParam(params.lagDays) ?? "0");

  const listQuery = trpc.personalExperiments.list.useQuery();
  const metricsQuery = trpc.personalExperiments.metrics.useQuery();
  const utils = trpc.useUtils();

  const [hypothesis, setHypothesis] = useState("");
  const [intervention, setIntervention] = useState("");
  const [outcomeMetricId, setOutcomeMetricId] = useState(prefilledOutcomeMetricId ?? "hrv");
  const [lagDays, setLagDays] = useState(
    Number.isFinite(prefilledLagDays) ? Math.min(7, Math.max(0, prefilledLagDays)) : 0,
  );
  const [baselineDays, setBaselineDays] = useState("7");
  const [interventionDays, setInterventionDays] = useState("14");
  const [startDate, setStartDate] = useState(formatDateYmd());

  const createMutation = trpc.personalExperiments.create.useMutation({
    onSuccess: async () => {
      setHypothesis("");
      setIntervention("");
      await utils.personalExperiments.list.invalidate();
    },
    onError: (error) => {
      captureException(error, { source: "personal-experiments-create" });
    },
  });

  const stopMutation = trpc.personalExperiments.stop.useMutation({
    onSuccess: async () => {
      await utils.personalExperiments.list.invalidate();
    },
    onError: (error) => {
      captureException(error, { source: "personal-experiments-stop" });
    },
  });

  const metrics = metricsQuery.data;
  const experiments = listQuery.data;

  const metricOptions = useMemo(() => metrics ?? [], [metrics]);

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Personal Experiments" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Start an experiment</Text>
          {prefilledOutcomeMetricId ? (
            <Text style={styles.helper}>
              Outcome and lag were prefilled from Correlation Explorer. Choose an intervention you
              can control.
            </Text>
          ) : null}

          {metricsQuery.isError && metrics === undefined ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(metricsQuery.error)}
              minHeight={72}
            />
          ) : metricsQuery.isLoading || metrics === undefined ? (
            <QueryStatePanel variant="loading" minHeight={72} />
          ) : (
            <View style={styles.form}>
              <Text style={styles.label}>Hypothesis</Text>
              <TextInput
                accessibilityLabel="Hypothesis"
                value={hypothesis}
                onChangeText={setHypothesis}
                placeholder="Does a consistent bedtime improve heart rate variability?"
                placeholderTextColor={colors.textTertiary}
                style={styles.input}
              />

              <Text style={styles.label}>Intervention</Text>
              <TextInput
                accessibilityLabel="Intervention"
                value={intervention}
                onChangeText={setIntervention}
                placeholder="Lights out by 10pm on weeknights"
                placeholderTextColor={colors.textTertiary}
                style={styles.input}
              />

              <Text style={styles.label}>Outcome metric</Text>
              <View style={styles.chipRow}>
                {metricOptions.map((metric) => (
                  <Pressable
                    key={metric.id}
                    onPress={() => setOutcomeMetricId(metric.id)}
                    style={[styles.chip, outcomeMetricId === metric.id && styles.chipActive]}
                    accessibilityRole="button"
                    accessibilityLabel={metric.label}
                    accessibilityState={{ selected: outcomeMetricId === metric.id }}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        outcomeMetricId === metric.id && styles.chipTextActive,
                      ]}
                    >
                      {metric.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Outcome lag</Text>
              <View style={styles.chipRow}>
                {[0, 1, 2, 3].map((value) => (
                  <Pressable
                    key={value}
                    onPress={() => setLagDays(value)}
                    style={[styles.chip, lagDays === value && styles.chipActive]}
                    accessibilityRole="button"
                    accessibilityLabel={value === 0 ? "Same day" : `Plus ${value} days`}
                    accessibilityState={{ selected: lagDays === value }}
                  >
                    <Text style={[styles.chipText, lagDays === value && styles.chipTextActive]}>
                      {value === 0 ? "Same day" : `+${value} day${value === 1 ? "" : "s"}`}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Baseline days</Text>
              <TextInput
                accessibilityLabel="Baseline days"
                value={baselineDays}
                onChangeText={setBaselineDays}
                keyboardType="number-pad"
                style={styles.input}
              />

              <Text style={styles.label}>Intervention days</Text>
              <TextInput
                accessibilityLabel="Intervention days"
                value={interventionDays}
                onChangeText={setInterventionDays}
                keyboardType="number-pad"
                style={styles.input}
              />

              <Text style={styles.label}>Start date</Text>
              <TextInput
                accessibilityLabel="Start date"
                value={startDate}
                onChangeText={setStartDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textTertiary}
                style={styles.input}
              />

              <Pressable
                style={styles.primaryButton}
                disabled={createMutation.isPending}
                onPress={() =>
                  createMutation.mutate({
                    hypothesis,
                    intervention,
                    outcomeMetricId,
                    lagDays,
                    baselineDays: Number(baselineDays) || 7,
                    interventionDays: Number(interventionDays) || 14,
                    startDate,
                  })
                }
                accessibilityRole="button"
                accessibilityLabel="Start experiment"
              >
                <Text style={styles.primaryButtonText}>
                  {createMutation.isPending
                    ? "Saving..."
                    : createMutation.error
                      ? "Retry"
                      : "Start experiment"}
                </Text>
              </Pressable>

              {createMutation.error ? (
                <QueryStatePanel
                  variant="error"
                  message={getQueryErrorMessage(createMutation.error)}
                  minHeight={72}
                />
              ) : null}
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Your experiments</Text>
          {metricsQuery.isError && metrics !== undefined ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(metricsQuery.error)}
              minHeight={72}
            />
          ) : null}

          {listQuery.isError && experiments === undefined ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(listQuery.error)}
              minHeight={96}
            />
          ) : listQuery.isLoading || experiments === undefined ? (
            <QueryStatePanel variant="loading" minHeight={96} />
          ) : experiments.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No experiments yet. Start one above, or open Correlation Explorer and choose Start experiment."
              minHeight={96}
            />
          ) : (
            <>
              {listQuery.isError ? (
                <QueryStatePanel
                  variant="error"
                  message={getQueryErrorMessage(listQuery.error)}
                  minHeight={72}
                />
              ) : null}
              {experiments.map((experiment) => (
                <View key={experiment.id} style={styles.experimentCard}>
                  <View style={styles.experimentHeader}>
                    <Text style={styles.experimentTitle}>{experiment.hypothesis}</Text>
                    <Text style={styles.phaseBadge}>{experiment.phaseLabel}</Text>
                  </View>
                  <Text style={styles.experimentMeta}>Intervention: {experiment.intervention}</Text>
                  <Text style={styles.experimentMeta}>
                    Outcome: {experiment.outcomeMetricLabel}
                    {experiment.lagDays > 0 ? ` (+${experiment.lagDays} day lag)` : ""}
                  </Text>
                  <Text style={styles.experimentMeta}>{experiment.schedule.scheduleSummary}</Text>
                  <Text style={styles.experimentMeta}>
                    Baseline {experiment.schedule.baselineStartDate} →{" "}
                    {experiment.schedule.baselineEndDate}
                  </Text>
                  <Text style={styles.experimentMeta}>
                    Intervention {experiment.schedule.interventionStartDate} →{" "}
                    {experiment.schedule.interventionEndDate}
                  </Text>
                  {experiment.status === "active" ? (
                    <Pressable
                      style={styles.secondaryButton}
                      disabled={
                        stopMutation.isPending && stopMutation.variables?.id === experiment.id
                      }
                      onPress={() => stopMutation.mutate({ id: experiment.id })}
                      accessibilityRole="button"
                      accessibilityLabel="Stop experiment"
                    >
                      <Text style={styles.secondaryButtonText}>
                        {stopMutation.isPending && stopMutation.variables?.id === experiment.id
                          ? "Stopping..."
                          : "Stop experiment"}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.experimentMeta}>Stopped on {experiment.stoppedAt}</Text>
                  )}
                  <ExperimentLearningCard experimentId={experiment.id} />
                </View>
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </>
  );
}

const adherenceOptions = [
  { value: "adherent", label: "Adherent" },
  { value: "partial", label: "Partial" },
  { value: "not_adherent", label: "Not adherent" },
  { value: "unknown", label: "Unknown" },
] as const;

type Adherence = (typeof adherenceOptions)[number]["value"];

function ExperimentLearningCard({ experimentId }: { experimentId: string }) {
  const analysisQuery = trpc.personalExperiments.analysis.useQuery({ id: experimentId });
  const utils = trpc.useUtils();
  const [adherence, setAdherence] = useState<Adherence>("adherent");
  const [confounder, setConfounder] = useState("");
  const [note, setNote] = useState("");
  const [annotationLabel, setAnnotationLabel] = useState("");
  const [annotationNotes, setAnnotationNotes] = useState("");
  const today = formatDateYmd();

  const checkInMutation = trpc.personalExperiments.checkIn.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.personalExperiments.analysis.invalidate({ id: experimentId }),
        utils.personalExperiments.list.invalidate(),
      ]);
    },
    onError: (error) => {
      captureException(error, { source: "personal-experiments-check-in" });
    },
  });

  const annotationMutation = trpc.lifeEvents.create.useMutation({
    onSuccess: async () => {
      setAnnotationLabel("");
      setAnnotationNotes("");
      await Promise.all([
        utils.personalExperiments.analysis.invalidate({ id: experimentId }),
        utils.lifeEvents.list.invalidate(),
      ]);
    },
    onError: (error) => {
      captureException(error, { source: "personal-experiments-annotation" });
    },
  });

  const result = analysisQuery.data;

  return (
    <View style={styles.learningCard}>
      <Text style={styles.learningTitle}>Outcome evidence</Text>
      {analysisQuery.isError && result === undefined ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(analysisQuery.error)}
          minHeight={72}
        />
      ) : null}
      {analysisQuery.isLoading || result === undefined ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : (
        <>
          <View style={styles.checkInForm}>
            <Text style={styles.label}>Today&apos;s adherence</Text>
            <View style={styles.chipRow}>
              {adherenceOptions.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => setAdherence(option.value)}
                  style={[styles.chip, adherence === option.value && styles.chipActive]}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityState={{ selected: adherence === option.value }}
                >
                  <Text
                    style={[styles.chipText, adherence === option.value && styles.chipTextActive]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              accessibilityLabel="Confounder"
              value={confounder}
              onChangeText={setConfounder}
              placeholder="Confounder (optional)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="Check-in note"
              value={note}
              onChangeText={setNote}
              placeholder="Check-in note (optional)"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
            />
            <Pressable
              style={styles.primaryButton}
              disabled={checkInMutation.isPending}
              onPress={() =>
                checkInMutation.mutate({
                  id: experimentId,
                  date: today,
                  adherence,
                  confounder: confounder.trim() || null,
                  note: note.trim() || null,
                })
              }
              accessibilityRole="button"
              accessibilityLabel="Record today's check-in"
            >
              <Text style={styles.primaryButtonText}>
                {checkInMutation.isPending
                  ? "Saving..."
                  : checkInMutation.error
                    ? "Retry check-in"
                    : "Record today's check-in"}
              </Text>
            </Pressable>
            {checkInMutation.error ? (
              <QueryStatePanel
                variant="error"
                message={getQueryErrorMessage(checkInMutation.error)}
                minHeight={72}
              />
            ) : null}
          </View>

          <Text
            style={styles.experimentMeta}
          >{`Baseline: ${result.analysis.coverage.baseline.observedOutcomeDayCount} of ${result.analysis.coverage.baseline.expectedDayCount} outcome days observed`}</Text>
          <Text
            style={styles.experimentMeta}
          >{`Intervention: ${result.analysis.coverage.intervention.observedOutcomeDayCount} of ${result.analysis.coverage.intervention.expectedDayCount} outcome days observed`}</Text>
          {result.analysis.effect ? (
            <Text style={styles.experimentMeta}>
              Mean difference: {result.analysis.effect.differenceInMeans}
            </Text>
          ) : null}
          {result.analysis.uncertainty.availability === "available" ? (
            <Text style={styles.experimentMeta}>
              Uncertainty interval: {result.analysis.uncertainty.lower} to{" "}
              {result.analysis.uncertainty.upper}
            </Text>
          ) : null}
          {result.analysis.limitations.map((limitation) => (
            <Text key={limitation} style={styles.experimentMeta}>
              Limitation: {limitation}
            </Text>
          ))}

          <Text style={styles.label}>Outcome observations</Text>
          {result.analysis.observations.map((observation) => (
            <Text
              key={`${observation.phase}-${observation.phaseDate}`}
              style={styles.experimentMeta}
            >
              {`${observation.phaseDate} → ${observation.outcomeDate}: ${observation.value ?? "Missing"}; ${observation.adherence ?? "baseline"}; sources: ${observation.sourceProviderIds.join(", ") || "none reported"}`}
            </Text>
          ))}

          <Text style={styles.label}>Linked annotations</Text>
          {result.annotations.map((annotation) => (
            <Text key={annotation.id} style={styles.experimentMeta}>
              {annotation.label}
              {annotation.notes ? `: ${annotation.notes}` : ""}
            </Text>
          ))}
          <TextInput
            accessibilityLabel="Annotation label"
            value={annotationLabel}
            onChangeText={setAnnotationLabel}
            placeholder="Annotation label"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Annotation notes"
            value={annotationNotes}
            onChangeText={setAnnotationNotes}
            placeholder="Annotation notes (optional)"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
          />
          <Pressable
            style={styles.secondaryButton}
            disabled={annotationMutation.isPending || annotationLabel.trim().length === 0}
            onPress={() =>
              annotationMutation.mutate({
                label: annotationLabel.trim(),
                startedAt: today,
                endedAt: null,
                category: null,
                ongoing: false,
                notes: annotationNotes.trim() || null,
                personalExperimentId: experimentId,
              })
            }
            accessibilityRole="button"
            accessibilityLabel="Save annotation"
          >
            <Text style={styles.secondaryButtonText}>
              {annotationMutation.isPending
                ? "Saving..."
                : annotationMutation.error
                  ? "Retry annotation"
                  : "Save annotation"}
            </Text>
          </Pressable>
          {annotationMutation.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(annotationMutation.error)}
              minHeight={72}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 12,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  helper: {
    fontSize: 13,
    color: colors.textTertiary,
    lineHeight: 18,
  },
  form: {
    gap: 8,
  },
  label: {
    fontSize: 11,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.background,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background,
  },
  chipActive: {
    backgroundColor: colors.surfaceSecondary,
  },
  chipText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  primaryButton: {
    marginTop: 8,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  secondaryButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  experimentCard: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 4,
  },
  learningCard: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 8,
    paddingTop: 12,
    gap: 8,
  },
  learningTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  checkInForm: {
    gap: 8,
  },
  experimentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    alignItems: "flex-start",
  },
  experimentTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  phaseBadge: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  experimentMeta: {
    fontSize: 12,
    color: colors.textTertiary,
  },
});
