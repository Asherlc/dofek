import { CYCLE_TRACKING_SAFETY_NOTICE, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/cycle")({
  component: CyclePage,
});

function sourceLabel(source: {
  providerId: string;
  sourceName: string | null;
  sourceBundle: string | null;
}): string {
  return source.sourceName ?? source.sourceBundle ?? source.providerId;
}

export function CyclePage() {
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const history = trpc.menstrualCycle.history.useQuery({ months: 6 });

  return (
    <PageLayout title="Cycle Tracking" subtitle="Provider-sourced cycle phases and history">
      <div className="space-y-6">
        <section aria-label="Cycle data source" className="card p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Read-only data</h2>
          <p className="mt-2 text-sm text-muted">
            Cycle records come from connected providers. To correct a date, update it in the source
            app and sync again.
          </p>
          <nav aria-label="Cycle data actions" className="mt-4 flex flex-wrap gap-2">
            <Link
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground"
              search={{ tab: "data-sources" }}
              to="/settings"
            >
              Data sources
            </Link>
            <Link
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground"
              search={{ tab: "privacy-export" }}
              to="/settings"
            >
              Export all data
            </Link>
            <Link
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground"
              search={{ tab: "privacy-export" }}
              to="/settings"
            >
              Delete account data
            </Link>
          </nav>
        </section>

        <section aria-labelledby="current-cycle-heading" className="card p-6">
          <h2
            className="mb-3 text-sm font-medium uppercase tracking-wider text-muted"
            id="current-cycle-heading"
          >
            Current phase
          </h2>
          {currentPhase.data ? (
            currentPhase.data.phase && currentPhase.data.estimate ? (
              <div>
                <div className="flex items-center gap-4">
                  <div
                    aria-label="Current cycle day"
                    className="flex h-16 w-16 items-center justify-center rounded-full text-lg font-bold text-white"
                    style={{ backgroundColor: PHASE_DISPLAY[currentPhase.data.phase].color }}
                  >
                    {currentPhase.data.dayOfCycle}
                  </div>
                  <div>
                    <p className="text-lg font-semibold">{currentPhase.data.estimate.phaseLabel}</p>
                    <p className="text-xs text-dim">{currentPhase.data.estimate.cycleDayLabel}</p>
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
              <div className="space-y-2 text-sm text-muted">
                <p>{currentPhase.data.availability.label}</p>
                {currentPhase.data.availability.status === "no-history" ? (
                  <p>
                    HealthKit cannot reveal whether read access was denied. Review Apple Health
                    permissions and sync status in Data sources.
                  </p>
                ) : null}
              </div>
            )
          ) : currentPhase.isLoading ? (
            <QueryStatePanel contextLabel="Current cycle phase" height={96} variant="loading" />
          ) : currentPhase.error ? (
            <QueryStatePanel contextLabel="Current cycle phase" error={currentPhase.error} height={96} />
          ) : (
            <QueryStatePanel message="No readable provider cycle data yet." height={96} />
          )}

          <aside
            aria-label="Cycle tracking safety notice"
            className="mt-4 rounded-lg border border-border bg-surface-hover p-3"
            role="note"
          >
            <p className="text-sm font-medium text-foreground">Tracking limitation</p>
            <p className="mt-1 text-sm text-muted">{CYCLE_TRACKING_SAFETY_NOTICE}</p>
          </aside>
        </section>

        <section aria-labelledby="cycle-history-heading" className="card p-6" id="cycle-history">
          <h2
            className="mb-3 text-sm font-medium uppercase tracking-wider text-muted"
            id="cycle-history-heading"
          >
            Provider cycle starts
          </h2>
          {history.data ? (
            history.data.length > 0 ? (
              <ul className="divide-y divide-border">
                {[...history.data].reverse().map((start) => (
                  <li
                    aria-label={`Cycle start ${start.startDate}`}
                    className="py-3"
                    key={start.id}
                  >
                    <p className="text-sm font-medium text-foreground">{start.startDate}</p>
                    <ul className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                      {start.sources.map((source) => (
                        <li
                          className="rounded-full border border-border px-2 py-1"
                          key={`${source.providerId}:${source.sourceBundle}:${source.sourceName}`}
                        >
                          {sourceLabel(source)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <QueryStatePanel message="No readable provider cycle starts in the past 6 months." />
            )
          ) : history.isLoading ? (
            <QueryStatePanel contextLabel="Cycle history" variant="loading" />
          ) : history.error ? (
            <QueryStatePanel contextLabel="Cycle history" error={history.error} />
          ) : (
            <QueryStatePanel message="No readable provider cycle starts in the past 6 months." />
          )}
        </section>
      </div>
    </PageLayout>
  );
}
