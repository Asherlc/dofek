import { totalSessionSeconds } from "@dofek/scoring/breathwork";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/breathwork")({
  component: BreathworkPage,
});

type SessionPhase = "inhale" | "hold-in" | "exhale" | "hold-out";

const PHASE_LABELS: Record<SessionPhase, string> = {
  inhale: "Breathe In",
  "hold-in": "Hold",
  exhale: "Breathe Out",
  "hold-out": "Hold",
};

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
  const { data: techniques } = trpc.breathwork.techniques.useQuery();
  const { data: history } = trpc.breathwork.history.useQuery({ days: 30 });
  const logMutation = trpc.breathwork.logSession.useMutation();
  const utils = trpc.useUtils();

  const [selectedTechniqueId, setSelectedTechniqueId] = useState<string>("box-breathing");
  const [isRunning, setIsRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SessionPhase>("inhale");
  const [phaseProgress, setPhaseProgress] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<string | null>(null);

  const selectedTechnique = techniques?.find((t) => t.id === selectedTechniqueId);

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
    let phaseElapsed = 0;
    let elapsed = 0;

    timerRef.current = setInterval(() => {
      phaseElapsed += 0.05;
      elapsed += 0.05;

      const currentPhaseDef = phases[phaseIdx];
      if (!currentPhaseDef) return;

      const progress = Math.min(phaseElapsed / currentPhaseDef.duration, 1);
      setPhaseProgress(progress);
      setCurrentPhase(currentPhaseDef.phase);

      if (phaseElapsed >= currentPhaseDef.duration) {
        phaseIdx++;
        phaseElapsed = 0;

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
            logMutation.mutate(
              {
                techniqueId: technique.id,
                rounds: technique.defaultRounds,
                durationSeconds: totalSeconds,
                startedAt: startTimeRef.current ?? new Date().toISOString(),
              },
              {
                onSuccess: () => {
                  utils.breathwork.history.invalidate();
                },
              },
            );
          }
        }
      }
    }, 50);
  }, [selectedTechnique, logMutation, utils]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <PageLayout
      title="Breathwork"
      subtitle="Guided breathing exercises for stress relief and recovery"
    >
      <div className="space-y-6">
        {/* Technique selector */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Choose Technique
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {techniques?.map((technique) => (
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
                <div className="text-xs text-dim mt-1 line-clamp-2">{technique.description}</div>
                <div className="text-xs text-muted mt-2">
                  {technique.defaultRounds} rounds
                  {selectedTechnique?.id === technique.id &&
                    ` / ${Math.round(totalSessionSeconds(technique, technique.defaultRounds) / 60)}m`}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Breathing animation */}
        <div className="card p-6">
          {isRunning ? (
            <>
              <div className="text-center text-xs text-muted mb-2">
                Round {Math.min(currentRound, selectedTechnique?.defaultRounds ?? 0)} of{" "}
                {selectedTechnique?.defaultRounds}
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
            <div className="flex flex-col items-center py-8">
              <div className="text-sm text-dim mb-4">
                {selectedTechnique?.name ?? "Select a technique"}
              </div>
              <button
                type="button"
                onClick={startSession}
                disabled={!selectedTechnique}
                className="px-8 py-3 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                Start Session
              </button>
            </div>
          )}
        </div>

        {/* History */}
        {history && history.length > 0 && (
          <div className="card p-6">
            <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
              Recent Sessions
            </h3>
            <div className="space-y-2">
              {history.map((session) => {
                const technique = techniques?.find((t) => t.id === session.techniqueId);
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
                        {new Date(session.startedAt).toLocaleDateString()}
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
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
