import { PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/cycle")({
  component: CyclePage,
});

function CyclePage() {
  const { data: phaseData, isLoading: phaseLoading } = trpc.menstrualCycle.currentPhase.useQuery();
  const { data: history, isLoading: historyLoading } = trpc.menstrualCycle.history.useQuery({
    months: 6,
  });

  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const utils = trpc.useUtils();
  const logMutation = trpc.menstrualCycle.logPeriod.useMutation({
    onSuccess: () => {
      utils.menstrualCycle.currentPhase.invalidate();
      utils.menstrualCycle.history.invalidate();
    },
  });

  const isLoading = phaseLoading || historyLoading;

  return (
    <PageLayout title="Cycle Tracking" subtitle="Menstrual cycle phases and history">
      {isLoading ? (
        <div className="card p-6 animate-pulse h-48" />
      ) : (
        <div className="space-y-6">
          {/* Current Phase */}
          <div className="card p-6">
            <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
              Current Phase
            </h3>
            {phaseData?.phase ? (
              <div className="flex items-center gap-4">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white font-bold text-lg"
                  style={{ backgroundColor: PHASE_DISPLAY[phaseData.phase].color }}
                >
                  {phaseData.dayOfCycle}
                </div>
                <div>
                  <div className="text-lg font-semibold">
                    {PHASE_DISPLAY[phaseData.phase].label}
                  </div>
                  <div className="text-xs text-dim">
                    Day {phaseData.dayOfCycle} of {phaseData.cycleLength}-day cycle
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-dim">
                No active cycle detected. Log a period start to begin tracking.
              </p>
            )}
          </div>

          {/* Log Period */}
          <div className="card p-6">
            <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
              Log Period Start
            </h3>
            <div className="flex items-center gap-3">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
              />
              <button
                type="button"
                onClick={() => logMutation.mutate({ startDate })}
                disabled={logMutation.isPending}
                className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {logMutation.isPending ? "Saving..." : "Log Period"}
              </button>
            </div>
          </div>

          {/* History */}
          {history && history.length > 0 && (
            <div className="card p-6">
              <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
                Period History
              </h3>
              <div className="space-y-2">
                {[...history].reverse().map((period) => (
                  <div
                    key={period.id}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div>
                      <span className="text-sm text-foreground">{period.startDate}</span>
                      {period.endDate && (
                        <span className="text-sm text-dim ml-1">to {period.endDate}</span>
                      )}
                    </div>
                    {period.cycleLength != null && (
                      <span className="text-xs text-muted">{period.cycleLength} day cycle</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PageLayout>
  );
}
