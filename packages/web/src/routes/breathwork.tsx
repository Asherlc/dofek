import { formatDateMedium } from "@dofek/format/format";
import { totalSessionSeconds } from "@dofek/scoring/breathwork";
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
const HISTORY_PAGE_SIZE = 20;

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
  const utils = trpc.useUtils();

  const [selectedTechniqueId, setSelectedTechniqueId] = useState<string>("box-breathing");
  const [isRunning, setIsRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SessionPhase>("inhale");
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [pendingSession, setPendingSession] = useState<CompletedSessionInput | null>(null);
  const [historyPage, setHistoryPage] = useState(0);

  const logMutation = trpc.breathwork.logSession.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      setPendingSession(null);
      setHistoryPage(0);
      utils.breathwork.history.invalidate();
    },
    onError: (error) => {
      captureException(error, { context: "breathwork-log-session" });
    },
  });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<string | null>(null);

  const selectedTechnique = techniques.data?.find((t) => t.id === selectedTechniqueId);
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
    if (!selectedTechnique) return;

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

            const totalSeconds = totalSessionSeconds(technique, technique.defaultRounds);
            const completedSession = {
              techniqueId: technique.id,
              rounds: technique.defaultRounds,
              durationSeconds: totalSeconds,
              startedAt: startTimeRef.current ?? new Date().toISOString(),
            };
            setPendingSession(completedSession);
            logMutation.mutate(completedSession);
          }
        }
      }
    }, 50);
  }, [selectedTechnique, logMutation]);

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
                    onClick={() => !isRunning && setSelectedTechniqueId(technique.id)}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      selectedTechniqueId === technique.id
                        ? "border-accent bg-accent/10"
                        : "border-border hover:border-border-strong"
                    } ${isRunning ? "opacity-50" : ""}`}
                    disabled={isRunning}
                  >
                    <div className="text-sm font-medium text-foreground">{technique.name}</div>
                    <div className="text-xs text-dim mt-1 line-clamp-2">
                      {technique.description}
                    </div>
                    <div className="text-xs text-muted mt-2">
                      {technique.defaultRounds} rounds
                      {selectedTechnique?.id === technique.id &&
                        ` / ${Math.round(
                          totalSessionSeconds(technique, technique.defaultRounds) / 60,
                        )}m`}
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
            ) : (
              <div className="space-y-5 py-4">
                <div className="text-center">
                  <div className="text-sm font-medium text-foreground">
                    {selectedTechnique.name}
                  </div>
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
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={startSession}
                    disabled={pendingSession !== null}
                    className="px-8 py-3 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
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
                  className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {logMutation.isPending ? "Saving..." : "Retry Save"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* History */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Recent Sessions
          </h3>
          {history.data !== undefined ? (
            history.data.length > 0 ? (
              <div className="space-y-2">
                {visibleHistory.map((session) => {
                  const technique = techniques.data?.find((t) => t.id === session.techniqueId);
                  return (
                    <div
                      key={session.id}
                      className="flex items-center justify-between py-2 border-b border-border last:border-0"
                    >
                      <div>
                        <span className="text-sm text-foreground">
                          {technique?.name ?? session.techniqueId}
                        </span>
                        <span className="text-xs text-dim ml-2">
                          {formatDateMedium(session.startedAt)}
                        </span>
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
