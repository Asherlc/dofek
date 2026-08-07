import { formatDurationSeconds } from "@dofek/format/format";
import type { BreathworkOutcomeReport, PerceivedBreathworkEffect } from "@dofek/scoring/breathwork";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

type SessionPhase = "inhale" | "hold-in" | "exhale" | "hold-out";

interface CompletedSessionInput extends BreathworkOutcomeReport {
  techniqueId: string;
  rounds: number;
  durationSeconds: number;
  startedAt: string;
}

const STRESS_RATINGS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const PHASE_LABELS: Record<SessionPhase, string> = {
  inhale: "Breathe In",
  "hold-in": "Hold",
  exhale: "Breathe Out",
  "hold-out": "Hold",
};

function techniqueAccessibilityLabel(technique: {
  name: string;
  purpose: string;
  description: string;
  durationSeconds: number;
  difficulty: string;
}): string {
  return `${technique.name}. ${technique.purpose}. ${technique.description} Duration: ${formatDurationSeconds(technique.durationSeconds)}. Difficulty: ${technique.difficulty}.`;
}

function StressScale({
  accessibilityPrefix,
  value,
  onChange,
}: {
  accessibilityPrefix: string;
  value: number | null;
  onChange: (value: number) => void;
}) {
  return (
    <View>
      <View style={styles.ratingRow}>
        {STRESS_RATINGS.map((rating) => (
          <Pressable
            key={rating}
            accessibilityLabel={`${accessibilityPrefix} ${rating}`}
            accessibilityRole="button"
            accessibilityState={{ selected: value === rating }}
            onPress={() => onChange(rating)}
            style={[styles.ratingButton, value === rating && styles.choiceSelected]}
          >
            <Text style={[styles.ratingText, value === rating && styles.choiceSelectedText]}>
              {rating}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.ratingLabels}>
        <Text style={styles.helperText}>Not stressed</Text>
        <Text style={styles.helperText}>Very stressed</Text>
      </View>
    </View>
  );
}

export default function BreathworkScreen() {
  const techniquesQuery = trpc.breathwork.techniques.useQuery();
  const outcomesQuery = trpc.breathwork.outcomes.useQuery();
  const utils = trpc.useUtils();
  const [selectedTechniqueId, setSelectedTechniqueId] = useState("box-breathing");
  const [isRunning, setIsRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SessionPhase>("inhale");
  const [pendingSession, setPendingSession] = useState<CompletedSessionInput | null>(null);
  const [stressBefore, setStressBefore] = useState<number | null>(null);
  const [stressAfter, setStressAfter] = useState<number | null>(null);
  const [dizzinessAfter, setDizzinessAfter] = useState<boolean | null>(null);
  const [perceivedEffect, setPerceivedEffect] = useState<PerceivedBreathworkEffect | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunningRef = useRef(false);
  const startTimeRef = useRef<string | null>(null);

  const techniques = techniquesQuery.data;
  const selectedTechnique =
    techniques?.find((technique) => technique.id === selectedTechniqueId) ?? techniques?.[0];
  const selectedOutcome = outcomesQuery.data?.techniques.find(
    (summary) => summary.techniqueId === selectedTechnique?.id,
  );

  const logMutation = trpc.breathwork.logSession.useMutation({
    meta: { errorReportedLocally: true },
    onSuccess: () => {
      setPendingSession(null);
      setStressBefore(null);
      setStressAfter(null);
      setDizzinessAfter(null);
      setPerceivedEffect(null);
      utils.breathwork.history.invalidate();
      utils.breathwork.outcomes.invalidate();
    },
    onError: (error) => {
      captureException(error, { context: "breathwork-log-session" });
    },
  });

  const stopSession = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    isRunningRef.current = false;
    setIsRunning(false);
    setCurrentRound(0);
    setCurrentPhase("inhale");
  }, []);

  const startSession = useCallback(() => {
    if (!selectedTechnique || isRunningRef.current) return;
    const technique = selectedTechnique;

    isRunningRef.current = true;
    setIsRunning(true);
    setCurrentRound(1);
    setCurrentPhase("inhale");
    startTimeRef.current = new Date().toISOString();

    const phases: { phase: SessionPhase; duration: number }[] = [
      { phase: "inhale", duration: technique.inhaleSeconds },
    ];
    if (technique.holdInSeconds) {
      phases.push({ phase: "hold-in", duration: technique.holdInSeconds });
    }
    phases.push({ phase: "exhale", duration: technique.exhaleSeconds });
    if (technique.holdOutSeconds) {
      phases.push({ phase: "hold-out", duration: technique.holdOutSeconds });
    }

    let round = 1;
    let phaseIndex = 0;

    function scheduleCurrentPhase(): void {
      const phase = phases[phaseIndex];
      if (!phase) return;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!isRunningRef.current) return;

        phaseIndex++;
        if (phaseIndex >= phases.length) {
          phaseIndex = 0;
          round++;
          if (round > technique.defaultRounds) {
            isRunningRef.current = false;
            setIsRunning(false);

            const completedSession = {
              techniqueId: technique.id,
              rounds: technique.defaultRounds,
              durationSeconds: technique.durationSeconds,
              startedAt: startTimeRef.current ?? new Date().toISOString(),
              stressBefore,
              stressAfter: null,
              dizzinessAfter: null,
              perceivedEffect: null,
            };
            setPendingSession(completedSession);
            return;
          }
          setCurrentRound(round);
        }

        const nextPhase = phases[phaseIndex];
        if (!nextPhase) return;
        setCurrentPhase(nextPhase.phase);
        scheduleCurrentPhase();
      }, phase.duration * 1_000);
    }

    scheduleCurrentPhase();
  }, [selectedTechnique, stressBefore]);

  const saveSession = useCallback(
    (reports: BreathworkOutcomeReport) => {
      if (!pendingSession) return;
      const input = { ...pendingSession, ...reports };
      setPendingSession(input);
      logMutation.mutate(input);
    },
    [logMutation, pendingSession],
  );

  useEffect(
    () => () => {
      isRunningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (techniquesQuery.isLoading && techniques === undefined) {
    return <QueryStatePanel variant="loading" />;
  }

  if (techniquesQuery.error && techniques === undefined) {
    return (
      <QueryStatePanel variant="error" message={getQueryErrorMessage(techniquesQuery.error)} />
    );
  }

  if (techniques?.length === 0) {
    return (
      <QueryStatePanel
        variant="empty"
        title="No breathwork techniques"
        message="No breathwork techniques are available."
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>Guided breathing with safety guidance before every session.</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Choose technique</Text>
        <View style={styles.techniqueList}>
          {techniques?.map((technique) => {
            const isSelected = selectedTechnique?.id === technique.id;
            return (
              <Pressable
                key={technique.id}
                accessibilityLabel={techniqueAccessibilityLabel(technique)}
                accessibilityRole="button"
                accessibilityState={{
                  selected: isSelected,
                  disabled: isRunning || pendingSession !== null,
                }}
                disabled={isRunning || pendingSession !== null}
                onPress={() => {
                  setSelectedTechniqueId(technique.id);
                  setStressBefore(null);
                }}
                style={[styles.techniqueButton, isSelected && styles.techniqueButtonSelected]}
              >
                <Text style={styles.techniqueName}>{technique.name}</Text>
                <Text style={styles.techniquePurpose}>{technique.purpose}</Text>
                <Text style={styles.techniqueDescription}>{technique.description}</Text>
                <Text style={styles.techniqueMeta}>
                  Duration: {formatDurationSeconds(technique.durationSeconds)} · Difficulty:{" "}
                  {technique.difficulty}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {selectedTechnique ? (
        <>
          {selectedTechnique.possibleBenefit ? (
            <View style={styles.card}>
              <Text style={styles.possibleBenefit}>{selectedTechnique.possibleBenefit}</Text>
            </View>
          ) : null}

          <View style={styles.safetyCard}>
            <Text style={styles.safetyTitle}>Safety before you start</Text>
            {selectedTechnique.safety.warnings.map((warning) => (
              <View key={warning} style={styles.warningRow}>
                <Text style={styles.warningBullet}>{"\u2022"}</Text>
                <Text style={styles.warning}>{warning}</Text>
              </View>
            ))}
            <Text style={styles.safetyText}>{selectedTechnique.safety.position}</Text>
            <Text style={styles.safetyText}>{selectedTechnique.safety.stopCriteria}</Text>
            <Text style={styles.safetyText}>{selectedTechnique.safety.emergency}</Text>
          </View>

          <View style={styles.sessionCard}>
            {isRunning ? (
              <>
                <Text style={styles.round}>
                  Round {currentRound} of {selectedTechnique.defaultRounds}
                </Text>
                <Text style={styles.phase}>{PHASE_LABELS[currentPhase]}</Text>
                <Pressable
                  accessibilityLabel="Stop Session"
                  accessibilityRole="button"
                  onPress={stopSession}
                  style={styles.stopButton}
                >
                  <Text style={styles.stopButtonText}>Stop</Text>
                </Pressable>
              </>
            ) : pendingSession ? (
              <View style={styles.checkIn}>
                <Text style={styles.checkInTitle}>How do you feel now?</Text>
                <Text style={styles.helperText}>This check-in is optional.</Text>

                <Text style={styles.question}>Stress right now</Text>
                <StressScale
                  accessibilityPrefix="After-session stress"
                  value={stressAfter}
                  onChange={setStressAfter}
                />

                <Text style={styles.question}>Compared with before the session</Text>
                <View style={styles.choiceRow}>
                  {(
                    [
                      ["better", "Felt better"],
                      ["same", "Felt the same"],
                      ["worse", "Felt worse"],
                    ] as const
                  ).map(([effect, label]) => (
                    <Pressable
                      key={effect}
                      accessibilityLabel={label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: perceivedEffect === effect }}
                      onPress={() => setPerceivedEffect(effect)}
                      style={[
                        styles.choiceButton,
                        perceivedEffect === effect && styles.choiceSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.choiceText,
                          perceivedEffect === effect && styles.choiceSelectedText,
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.question}>Did you feel dizzy?</Text>
                <View style={styles.choiceRow}>
                  <Pressable
                    accessibilityLabel="Dizziness"
                    accessibilityRole="button"
                    accessibilityState={{ selected: dizzinessAfter === true }}
                    onPress={() => setDizzinessAfter(true)}
                    style={[styles.choiceButton, dizzinessAfter === true && styles.choiceSelected]}
                  >
                    <Text
                      style={[
                        styles.choiceText,
                        dizzinessAfter === true && styles.choiceSelectedText,
                      ]}
                    >
                      Dizziness
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="No dizziness"
                    accessibilityRole="button"
                    accessibilityState={{ selected: dizzinessAfter === false }}
                    onPress={() => setDizzinessAfter(false)}
                    style={[styles.choiceButton, dizzinessAfter === false && styles.choiceSelected]}
                  >
                    <Text
                      style={[
                        styles.choiceText,
                        dizzinessAfter === false && styles.choiceSelectedText,
                      ]}
                    >
                      No dizziness
                    </Text>
                  </Pressable>
                </View>

                <Pressable
                  accessibilityLabel="Save session"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: logMutation.isPending }}
                  disabled={logMutation.isPending}
                  onPress={() =>
                    saveSession({
                      stressBefore,
                      stressAfter,
                      dizzinessAfter,
                      perceivedEffect,
                    })
                  }
                  style={styles.startButton}
                >
                  <Text style={styles.startButtonText}>
                    {logMutation.isPending ? "Saving..." : "Save session"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Skip check-in and save"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: logMutation.isPending }}
                  disabled={logMutation.isPending}
                  onPress={() =>
                    saveSession({
                      stressBefore: pendingSession.stressBefore,
                      stressAfter: null,
                      dizzinessAfter: null,
                      perceivedEffect: null,
                    })
                  }
                  style={styles.skipButton}
                >
                  <Text style={styles.skipButtonText}>Skip check-in and save</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.checkIn}>
                <Text style={styles.checkInTitle}>Optional check-in</Text>
                <Text style={styles.helperText}>
                  Record how you feel before and after to notice your own patterns.
                </Text>
                <Text style={styles.question}>Stress right now</Text>
                <StressScale
                  accessibilityPrefix="Before-session stress"
                  value={stressBefore}
                  onChange={setStressBefore}
                />
                <Pressable
                  accessibilityLabel="Start Session"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: pendingSession !== null }}
                  disabled={pendingSession !== null}
                  onPress={startSession}
                  style={styles.startButton}
                >
                  <Text style={styles.startButtonText}>Start Session</Text>
                </Pressable>
              </View>
            )}
          </View>
        </>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Your check-ins</Text>
        <Text style={styles.helperText}>Rolling {outcomesQuery.data?.windowDays ?? 30} days</Text>
        {outcomesQuery.data !== undefined ? (
          selectedOutcome &&
          (selectedOutcome.stress.reportCount > 0 ||
            selectedOutcome.perceivedEffect.reportCount > 0 ||
            selectedOutcome.dizziness.reportCount > 0) ? (
            <View style={styles.summaryList}>
              {selectedOutcome.stress.reportCount > 0 ? (
                <Text style={styles.summaryText}>
                  Stress after session: {selectedOutcome.stress.lowerCount} lower,{" "}
                  {selectedOutcome.stress.sameCount} same, {selectedOutcome.stress.higherCount}{" "}
                  higher ({selectedOutcome.stress.reportCount} paired check-ins)
                </Text>
              ) : null}
              {selectedOutcome.perceivedEffect.reportCount > 0 ? (
                <Text style={styles.summaryText}>
                  Overall feeling: {selectedOutcome.perceivedEffect.betterCount} better,{" "}
                  {selectedOutcome.perceivedEffect.sameCount} same,{" "}
                  {selectedOutcome.perceivedEffect.worseCount} worse (
                  {selectedOutcome.perceivedEffect.reportCount} responses)
                </Text>
              ) : null}
              {selectedOutcome.dizziness.reportCount > 0 ? (
                <Text style={styles.summaryText}>
                  Dizziness: {selectedOutcome.dizziness.yesCount} of{" "}
                  {selectedOutcome.dizziness.reportCount} responses
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.helperText}>
              Complete optional check-ins to see your personal pattern.
            </Text>
          )
        ) : outcomesQuery.isLoading ? (
          <QueryStatePanel variant="loading" minHeight={72} />
        ) : outcomesQuery.error ? (
          <QueryStatePanel
            variant="error"
            message={getQueryErrorMessage(outcomesQuery.error)}
            minHeight={72}
          />
        ) : null}
        <Text style={styles.disclaimer}>
          Patterns in your reports do not prove the breathing technique caused the change.
        </Text>
        {outcomesQuery.data !== undefined && outcomesQuery.error ? (
          <QueryStatePanel
            variant="error"
            message={getQueryErrorMessage(outcomesQuery.error)}
            minHeight={72}
          />
        ) : null}
      </View>

      {logMutation.error ? (
        <View style={styles.saveError}>
          <QueryStatePanel
            variant="error"
            message={getQueryErrorMessage(logMutation.error)}
            minHeight={88}
          />
          <Pressable
            accessibilityLabel="Retry Save"
            accessibilityRole="button"
            accessibilityState={{ disabled: !pendingSession || logMutation.isPending }}
            disabled={!pendingSession || logMutation.isPending}
            onPress={() => {
              if (pendingSession) logMutation.mutate(pendingSession);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.startButtonText}>
              {logMutation.isPending ? "Saving..." : "Retry Save"}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    paddingBottom: 100,
    gap: spacing.md,
  },
  intro: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    textTransform: "uppercase",
  },
  techniqueList: {
    gap: spacing.sm,
  },
  techniqueButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.xs,
  },
  techniqueButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceSecondary,
  },
  techniqueName: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  techniqueDescription: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  techniquePurpose: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  techniqueMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  possibleBenefit: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  safetyCard: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  safetyTitle: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  warning: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  warningRow: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  warningBullet: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  safetyText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  sessionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.md,
  },
  checkIn: {
    gap: spacing.md,
    width: "100%",
  },
  checkInTitle: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    textAlign: "center",
  },
  helperText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  question: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  ratingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  ratingButton: {
    alignItems: "center",
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
  },
  ratingText: {
    color: colors.text,
    fontSize: fontSize.sm,
  },
  ratingLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  choiceButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  choiceSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  choiceText: {
    color: colors.text,
    fontSize: fontSize.sm,
  },
  choiceSelectedText: {
    color: colors.textInverse,
  },
  round: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  phase: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  startButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  skipButton: {
    alignItems: "center",
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  skipButtonText: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  startButtonText: {
    color: colors.textInverse,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  stopButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  stopButtonText: {
    color: colors.textInverse,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  saveError: {
    gap: spacing.sm,
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  summaryList: {
    gap: spacing.xs,
  },
  summaryText: {
    color: colors.text,
    fontSize: fontSize.sm,
  },
  disclaimer: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
});
