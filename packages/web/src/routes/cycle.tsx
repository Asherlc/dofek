import { formatDateYmd } from "@dofek/format/format";
import { CYCLE_TRACKING_SAFETY_NOTICE, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/cycle")({
  component: CyclePage,
});

interface PeriodEditDraft {
  id: string;
  startDate: string;
  endDate: string;
  notes: string;
}

function CyclePage() {
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const periodHistory = trpc.menstrualCycle.history.useQuery({
    months: 6,
  });

  const [startDate, setStartDate] = useState(formatDateYmd());
  const [editDraft, setEditDraft] = useState<PeriodEditDraft | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const invalidateCycleData = async () => {
    await Promise.all([
      utils.menstrualCycle.currentPhase.invalidate(),
      utils.menstrualCycle.history.invalidate(),
    ]);
  };
  const logMutation = trpc.menstrualCycle.logPeriod.useMutation({
    meta: locallyReportedErrorMeta,
    onError: (error) => {
      captureException(error, { context: "cycle-log-period" });
    },
    onSettled: invalidateCycleData,
  });
  const updateMutation = trpc.menstrualCycle.updatePeriod.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      setEditDraft(null);
    },
    onError: (error) => {
      captureException(error, { context: "cycle-update-period" });
    },
    onSettled: invalidateCycleData,
  });
  const deleteMutation = trpc.menstrualCycle.deletePeriod.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      setDeleteConfirmationId(null);
    },
    onError: (error) => {
      captureException(error, { context: "cycle-delete-period" });
    },
    onSettled: invalidateCycleData,
  });

  return (
    <PageLayout title="Cycle Tracking" subtitle="Menstrual cycle phases and history">
      <div className="space-y-6">
        <section aria-label="Cycle data controls" className="card border-accent/30 bg-surface p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Privacy & data
          </h3>
          <p className="text-sm text-muted">
            Cycle entries and notes are sensitive health data. Review what is stored here; export
            all health data or permanently delete all account data from Account settings.
          </p>
          <nav aria-label="Cycle data actions" className="mt-4 flex flex-wrap gap-2">
            <a
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground hover:bg-surface-hover"
              href="#period-history"
            >
              Review cycle history
            </a>
            <Link
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground hover:bg-surface-hover"
              search={{ tab: "account" }}
              to="/settings"
            >
              Export all data
            </Link>
            <Link
              className="rounded border border-danger px-3 py-2 text-sm text-danger hover:bg-surface-hover"
              search={{ tab: "account" }}
              to="/settings"
            >
              Delete all data
            </Link>
          </nav>
        </section>

        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Current Phase
          </h3>
          {currentPhase.data !== undefined ? (
            currentPhase.data.phase && currentPhase.data.estimate ? (
              <div>
                <div className="flex items-center gap-4">
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center text-white font-bold text-lg"
                    style={{ backgroundColor: PHASE_DISPLAY[currentPhase.data.phase].color }}
                  >
                    {currentPhase.data.dayOfCycle}
                  </div>
                  <div>
                    <div className="text-lg font-semibold">
                      {currentPhase.data.estimate.phaseLabel}
                    </div>
                    <div className="text-xs text-dim">
                      {currentPhase.data.estimate.cycleDayLabel}
                    </div>
                  </div>
                </div>
                <div className="mt-4 space-y-1 text-sm text-muted">
                  <p>{currentPhase.data.estimate.dayBasisLabel}</p>
                  <p>{currentPhase.data.estimate.methodLabel}</p>
                  <p>{currentPhase.data.estimate.uncertaintyLabel}</p>
                  <p>{currentPhase.data.estimate.limitationLabel}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-dim">{currentPhase.data.availability.label}</p>
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
          <aside
            aria-label="Cycle tracking safety notice"
            className="mt-4 rounded-lg border border-border bg-surface-hover p-3"
            role="note"
          >
            <p className="text-sm font-medium text-foreground">Tracking limitation</p>
            <p className="mt-1 text-sm text-muted">{CYCLE_TRACKING_SAFETY_NOTICE}</p>
          </aside>
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
              className="px-4 py-2 bg-accent text-on-accent rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
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

        <div className="card p-6" id="period-history">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Period History
          </h3>
          {periodHistory.data !== undefined ? (
            periodHistory.data.length > 0 ? (
              <div className="space-y-2">
                {[...periodHistory.data].reverse().map((period) => (
                  <div key={period.id} className="py-3 border-b border-border last:border-0">
                    {editDraft?.id === period.id ? (
                      <form
                        className="space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          updateMutation.mutate({
                            id: editDraft.id,
                            startDate: editDraft.startDate,
                            endDate: editDraft.endDate || null,
                            notes: editDraft.notes.trim() || null,
                          });
                        }}
                      >
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="space-y-1 text-xs text-muted">
                            Start date
                            <input
                              aria-label="Corrected period start date"
                              className="block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
                              onChange={(event) =>
                                setEditDraft({ ...editDraft, startDate: event.target.value })
                              }
                              type="date"
                              value={editDraft.startDate}
                            />
                          </label>
                          <label className="space-y-1 text-xs text-muted">
                            End date (optional)
                            <input
                              aria-label="Corrected period end date"
                              className="block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
                              min={editDraft.startDate}
                              onChange={(event) =>
                                setEditDraft({ ...editDraft, endDate: event.target.value })
                              }
                              type="date"
                              value={editDraft.endDate}
                            />
                          </label>
                        </div>
                        <label className="block space-y-1 text-xs text-muted">
                          Notes (optional)
                          <input
                            aria-label="Period notes"
                            className="block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, notes: event.target.value })
                            }
                            type="text"
                            value={editDraft.notes}
                          />
                        </label>
                        <div className="flex gap-2">
                          <button
                            aria-label={
                              updateMutation.error ? "Retry period changes" : "Save period changes"
                            }
                            className="rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
                            disabled={updateMutation.isPending}
                            type="submit"
                          >
                            {updateMutation.isPending
                              ? "Saving..."
                              : updateMutation.error
                                ? "Retry"
                                : "Save"}
                          </button>
                          <button
                            className="rounded border border-border px-3 py-2 text-sm text-foreground"
                            onClick={() => {
                              updateMutation.reset();
                              setEditDraft(null);
                            }}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                        {updateMutation.error ? (
                          <QueryStatePanel error={updateMutation.error} height={72} />
                        ) : null}
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <span className="text-sm text-foreground">{period.startDate}</span>
                          {period.endDate ? (
                            <span className="ml-1 text-sm text-dim">to {period.endDate}</span>
                          ) : null}
                          {period.notes ? (
                            <p className="mt-1 text-xs text-muted">{period.notes}</p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {period.durationLabel ? (
                            <span className="text-xs text-muted">{period.durationLabel}</span>
                          ) : null}
                          <button
                            aria-label={`Edit period starting ${period.startDate}`}
                            className="rounded border border-border px-2 py-1 text-xs text-foreground"
                            onClick={() => {
                              updateMutation.reset();
                              deleteMutation.reset();
                              setDeleteConfirmationId(null);
                              setEditDraft({
                                id: period.id,
                                startDate: period.startDate,
                                endDate: period.endDate ?? "",
                                notes: period.notes ?? "",
                              });
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                          {deleteConfirmationId === period.id ? (
                            <>
                              <button
                                aria-label="Confirm delete period"
                                className="rounded bg-danger px-2 py-1 text-xs text-white disabled:opacity-50"
                                disabled={deleteMutation.isPending}
                                onClick={() => deleteMutation.mutate({ id: period.id })}
                                type="button"
                              >
                                {deleteMutation.isPending ? "Deleting..." : "Confirm delete"}
                              </button>
                              <button
                                className="rounded border border-border px-2 py-1 text-xs text-foreground"
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDeleteConfirmationId(null);
                                }}
                                type="button"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              aria-label={`Delete period starting ${period.startDate}`}
                              className="rounded border border-danger px-2 py-1 text-xs text-danger"
                              onClick={() => {
                                updateMutation.reset();
                                deleteMutation.reset();
                                setEditDraft(null);
                                setDeleteConfirmationId(period.id);
                              }}
                              type="button"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {deleteConfirmationId === period.id && deleteMutation.error ? (
                      <div className="mt-2">
                        <QueryStatePanel error={deleteMutation.error} height={72} />
                      </div>
                    ) : null}
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
