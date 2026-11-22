import {
  formatPlannedIntervals,
  PLANNED_INTERVAL_MATCH_EXPLANATION,
  PLANNED_INTERVAL_MATCH_SUMMARY,
  type PlannedIntervalInput,
} from "@dofek/format/planned-interval";

const TIMER_TONE_CLASS = {
  "on-plan": "",
  short: "text-amber-700 dark:text-amber-300",
  long: "text-amber-700 dark:text-amber-300",
} as const;

const ROW =
  "grid gap-2 sm:grid-cols-[minmax(7rem,0.72fr)_minmax(15rem,2fr)_minmax(6.75rem,0.75fr)] sm:items-center sm:gap-4";

/** Planned versus recorded cycling intervals; renders nothing without eligible rows. */
export function PlannedIntervalComparison({ rows }: { rows: PlannedIntervalInput[] }) {
  if (rows.length === 0) return null;
  const items = formatPlannedIntervals(rows);
  const first = items[0];
  return (
    <section aria-labelledby="planned-intervals-heading">
      <h2
        id="planned-intervals-heading"
        className="mb-2 text-sm font-medium text-muted uppercase tracking-wider"
      >
        Planned vs. recorded intervals
      </h2>
      <div className="card p-4">
        <div aria-hidden="true" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-5 rounded-sm border border-accent bg-accent/30" />
            Planned power
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-full bg-foreground" />
            Recorded average
          </span>
        </div>
        <div
          aria-hidden="true"
          className={`${ROW} hidden border-b border-border pb-2 text-xs font-medium text-muted sm:grid`}
        >
          <div>Interval</div>
          <div>
            Power
            {first ? (
              <div className="flex justify-between font-normal tabular-nums">
                <span>{first.scaleMinWatts} W</span>
                <span>{first.scaleMaxWatts} W</span>
              </div>
            ) : null}
          </div>
          <div>Timer duration</div>
        </div>
        <div className="text-sm">
          {items.map((item) => (
            <div
              key={item.key}
              className={`${ROW} border-t border-border py-3 first:border-t-0 sm:first:border-t-0`}
            >
              <h3 className="font-semibold">{item.name}</h3>
              <div>
                <div aria-hidden="true" className="relative mx-1 h-4">
                  <div className="absolute inset-x-0 top-2 border-t border-border" />
                  {item.isPoint ? (
                    <div
                      className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-accent"
                      style={{ left: `${item.targetStart}%` }}
                    />
                  ) : (
                    <div
                      className="absolute top-0.5 h-3 rounded-sm border border-accent bg-accent/30"
                      style={{
                        left: `${item.targetStart}%`,
                        width: `${item.targetWidth}%`,
                      }}
                    />
                  )}
                  {item.actualPosition != null ? (
                    <div
                      className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface bg-foreground"
                      style={{ left: `${item.actualPosition}%` }}
                    />
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 tabular-nums">
                  <span className={item.actualPosition == null ? "text-muted" : "font-semibold"}>
                    {item.recordedPower}
                  </span>
                  <span className="text-xs text-muted">{item.plannedPower}</span>
                </div>
              </div>
              <div className="tabular-nums">
                <span className="block text-xs text-muted sm:sr-only">Timer duration</span>
                <div className={`font-semibold ${TIMER_TONE_CLASS[item.timerTone]}`}>
                  {item.timer}
                </div>
                <div className="text-xs text-muted">{item.timerDetail}</div>
              </div>
            </div>
          ))}
        </div>
        <details className="mt-3 border-t border-border pt-3 text-xs text-muted">
          <summary className="w-fit cursor-pointer">{PLANNED_INTERVAL_MATCH_SUMMARY}</summary>
          <p className="mt-2 max-w-prose">{PLANNED_INTERVAL_MATCH_EXPLANATION}</p>
        </details>
      </div>
    </section>
  );
}
