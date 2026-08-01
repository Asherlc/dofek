import { formatDateMedium, formatDurationSeconds } from "@dofek/format/format";
import type { BreathworkOutcomeReport, PerceivedBreathworkEffect } from "@dofek/scoring/breathwork";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { PaginationControls } from "../components/PaginationControls.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/breathwork")({
  component: BreathworkPage,
});

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
const HISTORY_PAGE_SIZE = 20;

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
  label,
  accessibilityPrefix,
  value,
  onChange,
}: {
  label: string;
  accessibilityPrefix: string;
  value: number | null;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {STRESS_RATINGS.map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`${accessibilityPrefix} ${rating}`}
            aria-pressed={value === rating}
            onClick={() => onChange(rating)}
            className={`h-9 w-9 rounded border text-sm ${
              value === rating
                ? "border-accent bg-accent text-on-accent"
                : "border-border text-foreground hover:border-border-strong"
            }`}
          >
            {rating}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-dim">
        <span>Not stressed</span>
        <span>Very stressed</span>
      </div>
    </fieldset>
  );
}

function SessionOutcome({
  stressBefore,
  stressAfter,
  dizzinessAfter,
  perceivedEffect,
}: {
  stressBefore: number | null | undefined;
  stressAfter: number | null | undefined;
  dizzinessAfter: boolean | null | undefined;
  perceivedEffect: PerceivedBreathworkEffect | null | undefined;
}) {
  const parts: string[] = [];
  if (
    stressBefore !== null &&
    stressBefore !== undefined &&
    stressAfter !== null &&
    stressAfter !== undefined
  ) {
    parts.push(`Stress ${stressBefore} → ${stressAfter}`);
  }
  if (perceivedEffect === "better") parts.push("Felt better");
  if (perceivedEffect === "same") parts.push("Felt the same");
  if (perceivedEffect === "worse") parts.push("Felt worse");
  if (dizzinessAfter === true) parts.push("Dizziness");
  if (dizzinessAfter === false) parts.push("No dizziness");

  return parts.length > 0 ? <div className="mt-1 text-xs text-dim">{parts.join(" · ")}</div> : null;
}

function BreathingCircle({ phase, progress }: { phase: SessionPhase; progress: number }) {
  // Circle scales between 0.6 (exhale) and 1.0 (inhale)
  const scale =
    phase === "inhale"
      ? 0.6 + progress * 0.4
      : phase === "exhale"
        ? 1.0 - progress * 0.4
        : phase === "hold-in"
          ? 1.0
          : 0.6;

  return (
    <div className="flex flex-col items-center justify-center h-64">
      <div
        className="w-40 h-40 rounded-full bg-accent/30 border-2 border-accent flex items-center justify-center transition-transform duration-100"
        style={{ transform: `scale(${scale})` }}
      >
        <span className="text-lg font-semibold text-foreground">{PHASE_LABELS[phase]}</span>
      </div>
    </div>
  );
}

function BreathworkPage() {
  const techniques = trpc.breathwork.techniques.useQuery();
  const history = trpc.breathwork.history.useQuery({ days: 30 });
  const outcomes = trpc.breathwork.outcomes.useQuery();
  const utils = trpc.useUtils();

  const [selectedTechniqueId, setSelectedTechniqueId] = useState<string>("box-breathing");
  const [isRunning, setIsRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SessionPhase>("inhale");
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [pendingSession, setPendingSession] = useState<CompletedSessionInput | null>(null);
  const [stressBefore, setStressBefore] = useState<number | null>(null);
  const [stressAfter, setStressAfter] = useState<number | null>(null);
  const [dizzinessAfter, setDizzinessAfter] = useState<boolean | null>(null);
  const [perceivedEffect, setPerceivedEffect] = useState<PerceivedBreathworkEffect | null>(null);
  const [historyPage, setHistoryPage] = useState(0);

  const logMutation = trpc.breathwork.logSession.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      setPendingSession(null);
      setStressBefore(null);
      setStressAfter(null);
      setDizzinessAfter(null);
      setPerceivedEffect(null);
      setHistoryPage(0);
      utils.breathwork.history.invalidate();
      utils.breathwork.outcomes.invalidate();
    },
    onError: (error) => {
      captureException(error, { context: "breathwork-log-session" });
    },
  });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<string | null>(null);

  const selectedTechnique = techniques.data?.find((t) => t.id === selectedTechniqueId);
  const selectedOutcome = outcomes.data?.techniques.find(
    (summary) => summary.techniqueId === selectedTechniqueId,
  );
  const historyItems = history.data ?? [];
  const historyPageCount = Math.ceil(historyItems.length / HISTORY_PAGE_SIZE);
  const currentHistoryPage = Math.min(historyPage, Math.max(historyPageCount - 1, 0));
  const visibleHistory = historyItems.slice(
    currentHistoryPage * HISTORY_PAGE_SIZE,
    (currentHistoryPage + 1) * HISTORY_PAGE_SIZE,
  );

  const stopSession = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
    setCurrentRound(0);
    setCurrentPhase("inhale");
    setPhaseProgress(0);
  }, []);

  const startSession = useCallback(() => {
    if (timerRef.current || !selectedTechnique) return;

    setIsRunning(true);
    setCurrentRound(1);
    setCurrentPhase("inhale");
    setPhaseProgress(0);
    startTimeRef.current = new Date().toISOString();

    let round = 1;
    const technique = selectedTechnique;

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

    let phaseIdx = 0;
    let phaseElapsedMs = 0;

    timerRef.current = setInterval(() => {
      phaseElapsedMs += 50;

      const currentPhaseDef = phases[phaseIdx];
      if (!currentPhaseDef) return;

      const phaseDurationMs = currentPhaseDef.duration * 1_000;
      const progress = Math.min(phaseElapsedMs / phaseDurationMs, 1);
      setPhaseProgress(progress);
      setCurrentPhase(currentPhaseDef.phase);

      if (phaseElapsedMs >= phaseDurationMs) {
        phaseIdx++;
        phaseElapsedMs = 0;

        if (phaseIdx >= phases.length) {
          phaseIdx = 0;
          round++;
          setCurrentRound(round);

          if (round > technique.defaultRounds) {
            // Session complete
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
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
          }
        }
      }
    }, 50);
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

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <PageLayout
      title="Breathwork"
      subtitle="Guided breathing exercises with pre-session safety guidance"
    >
      <div className="space-y-6">
        {/* Technique selector */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Choose Technique
          </h3>
          {techniques.data !== undefined ? (
            techniques.data.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {techniques.data.map((technique) => (
                  <button
                    key={technique.id}
                    type="button"
                    aria-label={techniqueAccessibilityLabel(technique)}
                    onClick={() => {
                      if (!isRunning) {
                        setSelectedTechniqueId(technique.id);
                        setStressBefore(null);
                      }
                    }}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      selectedTechniqueId === technique.id
                        ? "border-accent bg-accent/10"
                        : "border-border hover:border-border-strong"
                    } ${isRunning || pendingSession !== null ? "opacity-50" : ""}`}
                    disabled={isRunning || pendingSession !== null}
                  >
                    <div className="text-sm font-medium text-foreground">{technique.name}</div>
                    <div className="text-xs text-dim mt-1">{technique.purpose}</div>
                    <div className="text-xs text-dim mt-1">{technique.description}</div>
                    <div className="text-xs text-muted mt-2">
                      {technique.defaultRounds} rounds · Duration:{" "}
                      {formatDurationSeconds(technique.durationSeconds)} · Difficulty:{" "}
                      {technique.difficulty}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <QueryStatePanel
                variant="empty"
                message="No breathwork techniques are available."
                height={96}
              />
            )
          ) : techniques.isLoading ? (
            <QueryStatePanel variant="loading" height={96} />
          ) : techniques.error ? (
            <QueryStatePanel error={techniques.error} height={96} />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No breathwork techniques are available."
              height={96}
            />
          )}
          {techniques.data !== undefined && techniques.error ? (
            <QueryStatePanel error={techniques.error} height={72} />
          ) : null}
        </div>

        {/* Breathing animation */}
        {selectedTechnique ? (
          <div className="card p-6">
            {isRunning ? (
              <>
                <div className="text-center text-xs text-muted mb-2">
                  Round {Math.min(currentRound, selectedTechnique.defaultRounds)} of{" "}
                  {selectedTechnique.defaultRounds}
                </div>
                <BreathingCircle phase={currentPhase} progress={phaseProgress} />
                <div className="flex justify-center mt-4">
                  <button
                    type="button"
                    onClick={stopSession}
                    className="px-6 py-2 bg-red-500/15 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/25 transition-colors"
                  >
                    Stop
                  </button>
                </div>
              </>
            ) : pendingSession ? (
              <section className="space-y-5 py-4" aria-labelledby="post-session-heading">
                <div className="text-center">
                  <h3 id="post-session-heading" className="text-base font-semibold text-foreground">
                    How do you feel now?
                  </h3>
                  <p className="mt-1 text-sm text-dim">This check-in is optional.</p>
                </div>
                <StressScale
                  label="Stress right now"
                  accessibilityPrefix="After-session stress"
                  value={stressAfter}
                  onChange={setStressAfter}
                />
                <fieldset>
                  <legend className="text-sm font-medium text-foreground">
                    Compared with before the session
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        ["better", "Felt better"],
                        ["same", "Felt the same"],
                        ["worse", "Felt worse"],
                      ] as const
                    ).map(([effect, label]) => (
                      <button
                        key={effect}
                        type="button"
                        aria-pressed={perceivedEffect === effect}
                        onClick={() => setPerceivedEffect(effect)}
                        className={`rounded border px-3 py-2 text-sm ${
                          perceivedEffect === effect
                            ? "border-accent bg-accent text-on-accent"
                            : "border-border text-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium text-foreground">
                    Did you feel dizzy?
                  </legend>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      aria-pressed={dizzinessAfter === true}
                      onClick={() => setDizzinessAfter(true)}
                      className={`rounded border px-3 py-2 text-sm ${
                        dizzinessAfter === true
                          ? "border-accent bg-accent text-on-accent"
                          : "border-border text-foreground"
                      }`}
                    >
                      Dizziness
                    </button>
                    <button
                      type="button"
                      aria-pressed={dizzinessAfter === false}
                      onClick={() => setDizzinessAfter(false)}
                      className={`rounded border px-3 py-2 text-sm ${
                        dizzinessAfter === false
                          ? "border-accent bg-accent text-on-accent"
                          : "border-border text-foreground"
                      }`}
                    >
                      No dizziness
                    </button>
                  </div>
                </fieldset>
                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      saveSession({
                        stressBefore,
                        stressAfter,
                        dizzinessAfter,
                        perceivedEffect,
                      })
                    }
                    disabled={logMutation.isPending}
                    className="rounded bg-accent px-6 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
                  >
                    {logMutation.isPending ? "Saving..." : "Save session"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      saveSession({
                        stressBefore: pendingSession.stressBefore,
                        stressAfter: null,
                        dizzinessAfter: null,
                        perceivedEffect: null,
                      })
                    }
                    disabled={logMutation.isPending}
                    className="rounded border border-border px-6 py-2 text-sm text-foreground disabled:opacity-50"
                  >
                    Skip check-in and save
                  </button>
                </div>
              </section>
            ) : (
              <div className="space-y-5 py-4">
                <div className="text-center">
                  <div className="text-sm font-medium text-foreground">
                    {selectedTechnique.name}
                  </div>
                  <p className="mt-1 text-sm text-dim">{selectedTechnique.purpose}</p>
                  <p className="mt-1 text-sm text-dim">{selectedTechnique.description}</p>
                  {selectedTechnique.possibleBenefit ? (
                    <p className="mt-2 text-sm text-muted">{selectedTechnique.possibleBenefit}</p>
                  ) : null}
                </div>
                <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                  <h3 className="text-sm font-semibold text-foreground">Safety before you start</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
                    {selectedTechnique.safety.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <div className="mt-3 space-y-1 text-sm text-dim">
                    <p>{selectedTechnique.safety.position}</p>
                    <p>{selectedTechnique.safety.stopCriteria}</p>
                    <p>{selectedTechnique.safety.emergency}</p>
                  </div>
                </section>
                <section className="rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground">Optional check-in</h3>
                  <p className="mt-1 text-sm text-dim">
                    Record how you feel before and after to notice your own patterns.
                  </p>
                  <div className="mt-3">
                    <StressScale
                      label="Stress right now"
                      accessibilityPrefix="Before-session stress"
                      value={stressBefore}
                      onChange={setStressBefore}
                    />
                  </div>
                </section>
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={startSession}
                    disabled={pendingSession !== null}
                    className="px-8 py-3 bg-accent text-on-accent rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                  >
                    Start Session
                  </button>
                </div>
              </div>
            )}
            {logMutation.error ? (
              <div className="mt-4 space-y-3">
                <QueryStatePanel error={logMutation.error} height={72} />
                <button
                  type="button"
                  onClick={() => {
                    if (pendingSession) logMutation.mutate(pendingSession);
                  }}
                  disabled={!pendingSession || logMutation.isPending}
                  className="px-4 py-2 bg-accent text-on-accent rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {logMutation.isPending ? "Saving..." : "Retry Save"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider">
            Your check-ins
          </h3>
          <p className="mt-1 text-xs text-dim">Rolling {outcomes.data?.windowDays ?? 30} days</p>
          {outcomes.data !== undefined ? (
            selectedOutcome &&
            (selectedOutcome.stress.reportCount > 0 ||
              selectedOutcome.perceivedEffect.reportCount > 0 ||
              selectedOutcome.dizziness.reportCount > 0) ? (
              <div className="mt-3 space-y-1 text-sm text-foreground">
                {selectedOutcome.stress.reportCount > 0 ? (
                  <p>
                    Stress after session: {selectedOutcome.stress.lowerCount} lower,{" "}
                    {selectedOutcome.stress.sameCount} same, {selectedOutcome.stress.higherCount}{" "}
                    higher ({selectedOutcome.stress.reportCount} paired check-ins)
                  </p>
                ) : null}
                {selectedOutcome.perceivedEffect.reportCount > 0 ? (
                  <p>
                    Overall feeling: {selectedOutcome.perceivedEffect.betterCount} better,{" "}
                    {selectedOutcome.perceivedEffect.sameCount} same,{" "}
                    {selectedOutcome.perceivedEffect.worseCount} worse (
                    {selectedOutcome.perceivedEffect.reportCount} responses)
                  </p>
                ) : null}
                {selectedOutcome.dizziness.reportCount > 0 ? (
                  <p>
                    Dizziness: {selectedOutcome.dizziness.yesCount} of{" "}
                    {selectedOutcome.dizziness.reportCount} responses
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-dim">
                Complete optional check-ins to see your personal pattern.
              </p>
            )
          ) : outcomes.isLoading ? (
            <QueryStatePanel variant="loading" height={72} />
          ) : outcomes.error ? (
            <QueryStatePanel error={outcomes.error} height={72} />
          ) : null}
          <p className="mt-3 text-xs text-dim">
            Patterns in your reports do not prove the breathing technique caused the change.
          </p>
          {outcomes.data !== undefined && outcomes.error ? (
            <QueryStatePanel error={outcomes.error} height={72} />
          ) : null}
        </div>

        {/* History */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Recent Sessions
          </h3>
          {history.data !== undefined ? (
            history.data.length > 0 ? (
              <div className="space-y-2">
                {visibleHistory.map((session) => {
                  return (
                    <div
                      key={session.id}
                      className="flex items-center justify-between py-2 border-b border-border last:border-0"
                    >
                      <div>
                        <span className="text-sm text-foreground">
                          {session.techniqueLabel ?? "Breathwork session"}
                        </span>
                        <span className="text-xs text-dim ml-2">
                          {formatDateMedium(session.startedAt)}
                        </span>
                        <SessionOutcome
                          stressBefore={session.stressBefore}
                          stressAfter={session.stressAfter}
                          dizzinessAfter={session.dizzinessAfter}
                          perceivedEffect={session.perceivedEffect}
                        />
                      </div>
                      <div className="text-right">
                        <span className="text-xs text-muted">
                          {session.rounds} rounds / {Math.round(session.durationSeconds / 60)}m
                        </span>
                      </div>
                    </div>
                  );
                })}
                <PaginationControls
                  page={currentHistoryPage}
                  pageSize={HISTORY_PAGE_SIZE}
                  totalItems={historyItems.length}
                  itemLabel="sessions"
                  onPageChange={setHistoryPage}
                />
              </div>
            ) : (
              <QueryStatePanel
                variant="empty"
                message="No breathwork sessions logged yet."
                height={96}
              />
            )
          ) : history.isLoading ? (
            <QueryStatePanel variant="loading" height={96} />
          ) : history.error ? (
            <QueryStatePanel error={history.error} height={96} />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No breathwork sessions logged yet."
              height={96}
            />
          )}
          {history.data !== undefined && history.error ? (
            <QueryStatePanel error={history.error} height={72} />
          ) : null}
        </div>
      </div>
    </PageLayout>
  );
}
