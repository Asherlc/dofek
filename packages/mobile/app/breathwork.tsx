import { totalSessionSeconds } from "@dofek/scoring/breathwork";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

type SessionPhase = "inhale" | "hold-in" | "exhale" | "hold-out";

interface CompletedSessionInput {
  techniqueId: string;
  rounds: number;
  durationSeconds: number;
  startedAt: string;
}

const PHASE_LABELS: Record<SessionPhase, string> = {
  inhale: "Breathe In",
  "hold-in": "Hold",
  exhale: "Breathe Out",
  "hold-out": "Hold",
};

export default function BreathworkScreen() {
  const techniquesQuery = trpc.breathwork.techniques.useQuery();
  const [selectedTechniqueId, setSelectedTechniqueId] = useState("box-breathing");
  const [isRunning, setIsRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SessionPhase>("inhale");
  const [pendingSession, setPendingSession] = useState<CompletedSessionInput | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<string | null>(null);

  const techniques = techniquesQuery.data;
  const selectedTechnique =
    techniques?.find((technique) => technique.id === selectedTechniqueId) ?? techniques?.[0];

  const logMutation = trpc.breathwork.logSession.useMutation({
    meta: { errorReportedLocally: true },
    onSuccess: () => {
      setPendingSession(null);
    },
    onError: (error) => {
      captureException(error, { context: "breathwork-log-session" });
    },
  });

  const stopSession = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
    setCurrentRound(0);
    setCurrentPhase("inhale");
  }, []);

  const startSession = useCallback(() => {
    if (!selectedTechnique) return;

    setIsRunning(true);
    setCurrentRound(1);
    setCurrentPhase("inhale");
    startTimeRef.current = new Date().toISOString();

    const phases: { phase: SessionPhase; duration: number }[] = [
      { phase: "inhale", duration: selectedTechnique.inhaleSeconds },
    ];
    if (selectedTechnique.holdInSeconds) {
      phases.push({ phase: "hold-in", duration: selectedTechnique.holdInSeconds });
    }
    phases.push({ phase: "exhale", duration: selectedTechnique.exhaleSeconds });
    if (selectedTechnique.holdOutSeconds) {
      phases.push({ phase: "hold-out", duration: selectedTechnique.holdOutSeconds });
    }

    let round = 1;
    let phaseIndex = 0;
    let phaseElapsedMs = 0;

    timerRef.current = setInterval(() => {
      const phase = phases[phaseIndex];
      if (!phase) return;

      phaseElapsedMs += 50;
      setCurrentPhase(phase.phase);

      if (phaseElapsedMs < phase.duration * 1_000) return;

      phaseIndex++;
      phaseElapsedMs = 0;
      if (phaseIndex < phases.length) return;

      phaseIndex = 0;
      round++;
      if (round <= selectedTechnique.defaultRounds) {
        setCurrentRound(round);
        return;
      }

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsRunning(false);

      const completedSession = {
        techniqueId: selectedTechnique.id,
        rounds: selectedTechnique.defaultRounds,
        durationSeconds: totalSessionSeconds(selectedTechnique, selectedTechnique.defaultRounds),
        startedAt: startTimeRef.current ?? new Date().toISOString(),
      };
      setPendingSession(completedSession);
      logMutation.mutate(completedSession);
    }, 50);
  }, [logMutation, selectedTechnique]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
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
                accessibilityLabel={technique.name}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected, disabled: isRunning }}
                disabled={isRunning}
                onPress={() => setSelectedTechniqueId(technique.id)}
                style={[styles.techniqueButton, isSelected && styles.techniqueButtonSelected]}
              >
                <Text style={styles.techniqueName}>{technique.name}</Text>
                <Text style={styles.techniqueDescription}>{technique.description}</Text>
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
            ) : (
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
            )}
          </View>
        </>
      ) : null}

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
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.md,
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
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  startButtonText: {
    color: colors.surface,
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
    color: colors.surface,
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
});
