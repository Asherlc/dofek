import { formatDateYmd } from "@dofek/format/format";
import { PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/cycle")({
  component: CyclePage,
});

function CyclePage() {
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const periodHistory = trpc.menstrualCycle.history.useQuery({
    months: 6,
  });

  const [startDate, setStartDate] = useState(formatDateYmd());
  const utils = trpc.useUtils();
  const logMutation = trpc.menstrualCycle.logPeriod.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      await Promise.all([
        utils.menstrualCycle.currentPhase.invalidate(),
        utils.menstrualCycle.history.invalidate(),
      ]);
    },
    onError: (error) => {
      captureException(error, { context: "cycle-log-period" });
    },
  });

  return (
    <PageLayout title="Cycle Tracking" subtitle="Menstrual cycle phases and history">
      <div className="space-y-6">
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Current Phase
          </h3>
          {currentPhase.data !== undefined ? (
            currentPhase.data.phase ? (
              <div className="flex items-center gap-4">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white font-bold text-lg"
                  style={{ backgroundColor: PHASE_DISPLAY[currentPhase.data.phase].color }}
                >
                  {currentPhase.data.dayOfCycle}
                </div>
                <div>
                  <div className="text-lg font-semibold">
                    {PHASE_DISPLAY[currentPhase.data.phase].label}
                  </div>
                  <div className="text-xs text-dim">
                    Day {currentPhase.data.dayOfCycle} of {currentPhase.data.cycleLength}-day cycle
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-dim">
                No active cycle detected. Log a period start to begin tracking.
              </p>
            )
          ) : currentPhase.isLoading ? (
            <QueryStatePanel variant="loading" height={96} />
          ) : currentPhase.error ? (
            <QueryStatePanel error={currentPhase.error} height={96} />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No active cycle detected. Log a period start to begin tracking."
              height={96}
            />
          )}
          {currentPhase.data !== undefined && currentPhase.error ? (
            <QueryStatePanel error={currentPhase.error} height={72} />
          ) : null}
        </div>

        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Log Period Start
          </h3>
          <div className="flex items-center gap-3">
            <input
              type="date"
              aria-label="Period start date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
            />
            <button
              type="button"
              onClick={() => logMutation.mutate({ startDate })}
              disabled={logMutation.isPending}
              className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {logMutation.isPending ? "Saving..." : logMutation.error ? "Retry" : "Log Period"}
            </button>
          </div>
          {logMutation.error ? (
            <div className="mt-3">
              <QueryStatePanel error={logMutation.error} height={72} />
            </div>
          ) : null}
        </div>

        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Period History
          </h3>
          {periodHistory.data !== undefined ? (
            periodHistory.data.length > 0 ? (
              <div className="space-y-2">
                {[...periodHistory.data].reverse().map((period) => (
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
                    {period.durationLabel && (
                      <span className="text-xs text-muted">{period.durationLabel}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <QueryStatePanel variant="empty" message="No periods logged yet." height={96} />
            )
          ) : periodHistory.isLoading ? (
            <QueryStatePanel variant="loading" height={96} />
          ) : periodHistory.error ? (
            <QueryStatePanel error={periodHistory.error} height={96} />
          ) : (
            <QueryStatePanel variant="empty" message="No periods logged yet." height={96} />
          )}
          {periodHistory.data !== undefined && periodHistory.error ? (
            <QueryStatePanel error={periodHistory.error} height={72} />
          ) : null}
        </div>
      </div>
    </PageLayout>
  );
}
