import {
  formatBodyCompositionPercent,
  formatDateMedium,
  formatDateYmd,
  formatDurationMinutes,
  formatHRV,
  formatNumber,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { useState } from "react";
import { z } from "zod";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { PaginationControls } from "./PaginationControls.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const lifeEventSchema = z.object({
  id: z.string(),
  label: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  category: z.string().nullable(),
  ongoing: z.boolean(),
  notes: z.string().nullable(),
});
type LifeEvent = z.infer<typeof lifeEventSchema>;

const analysisMetricSchema = z.object({
  period: z.string(),
  days: z.number().optional(),
  nights: z.number().optional(),
  measurements: z.number().optional(),
  avg_resting_hr: z.number().optional(),
  avg_hrv: z.number().optional(),
  avg_steps: z.number().optional(),
  avg_sleep_min: z.number().optional(),
  avg_deep_min: z.number().optional(),
  avg_rem_min: z.number().optional(),
  avg_efficiency: z.number().optional(),
  avg_weight: z.number().optional(),
  avg_body_fat: z.number().optional(),
});
type AnalysisMetric = z.infer<typeof analysisMetricSchema>;

const eventAnalysisDataSchema = z.object({
  event: lifeEventSchema,
  metrics: z.array(analysisMetricSchema),
  sleep: z.array(analysisMetricSchema),
  bodyComp: z.array(analysisMetricSchema),
});
type EventAnalysisData = z.infer<typeof eventAnalysisDataSchema>;

const CATEGORIES = ["diet", "supplement", "injury", "lifestyle", "training", "other"] as const;
const PAGE_SIZE = 20;

export function LifeEventsPanel() {
  const [showForm, setShowForm] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [page, setPage] = useState(0);

  const utils = trpc.useUtils();
  const events = trpc.lifeEvents.list.useQuery();
  const createMutation = trpc.lifeEvents.create.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      utils.lifeEvents.list.invalidate();
      setShowForm(false);
    },
    onError: (error) => {
      captureException(error, { operation: "lifeEvents.create" });
    },
  });
  const deleteMutation = trpc.lifeEvents.delete.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => {
      utils.lifeEvents.list.invalidate();
      setSelectedEvent(null);
    },
    onError: (error) => {
      captureException(error, { operation: "lifeEvents.delete" });
    },
  });
  const analysis = trpc.lifeEvents.analyze.useQuery(
    { id: selectedEvent ?? "", windowDays },
    { enabled: !!selectedEvent },
  );

  const eventList =
    events.data === undefined ? undefined : z.array(lifeEventSchema).parse(events.data);
  const totalPages = Math.ceil((eventList?.length ?? 0) / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages - 1, 0));
  const visibleEvents = eventList?.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="space-y-4">
      {events.isLoading && events.data === undefined ? (
        <QueryStatePanel variant="loading" height={96} />
      ) : null}
      {events.error ? (
        <QueryStatePanel
          error={events.error}
          height={96}
          onRetry={() => void events.refetch()}
          retryLabel="Retry life events"
          retrying={events.isFetching}
        />
      ) : null}

      {/* Event list + add button */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-wrap gap-2">
          {visibleEvents?.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelectedEvent(selectedEvent === e.id ? null : e.id)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                selectedEvent === e.id
                  ? "bg-blue-900/50 border-blue-700 text-blue-300"
                  : "bg-surface-solid border-border text-muted hover:text-foreground hover:border-border-strong"
              }`}
            >
              <span className="mr-1.5">{categoryIcon(e.category)}</span>
              {e.label}
              <span className="ml-1.5 text-dim">
                {formatDate(e.started_at)}
                {e.ended_at ? ` — ${formatDate(e.ended_at)}` : e.ongoing ? " — now" : ""}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="w-full shrink-0 text-xs px-3 py-1.5 rounded-lg bg-accent/10 border border-border-strong text-foreground hover:bg-surface-hover transition-colors sm:w-auto"
        >
          + Add event
        </button>
      </div>

      <PaginationControls
        page={currentPage}
        pageSize={PAGE_SIZE}
        totalItems={eventList?.length ?? 0}
        itemLabel="life events"
        onPageChange={(nextPage) => {
          setPage(nextPage);
          setSelectedEvent(null);
        }}
      />

      {eventList?.length === 0 ? (
        <p className="text-dim text-sm text-center py-6">No life events yet.</p>
      ) : null}

      {/* Add form */}
      {showForm && (
        <>
          <AddEventForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowForm(false)}
            loading={createMutation.isPending}
          />
          {createMutation.error ? (
            <p className="text-xs text-red-400">{createMutation.error.message}</p>
          ) : null}
        </>
      )}

      {/* Analysis */}
      {(() => {
        if (!selectedEvent || !eventList || eventList.length === 0) return null;
        const event = eventList.find((e) => e.id === selectedEvent);
        if (!event) return null;
        return (
          <>
            {analysis.error ? (
              <QueryStatePanel
                error={analysis.error}
                height={96}
                onRetry={() => void analysis.refetch()}
                retryLabel="Retry event analysis"
                retrying={analysis.isFetching}
              />
            ) : null}
            <EventAnalysis
              event={event}
              analysis={eventAnalysisDataSchema.nullable().parse(analysis.data ?? null)}
              loading={analysis.isLoading && analysis.data === undefined}
              windowDays={windowDays}
              onWindowChange={setWindowDays}
              onDelete={() => deleteMutation.mutate({ id: selectedEvent })}
              deleting={deleteMutation.isPending}
            />
            {deleteMutation.error ? (
              <p className="text-xs text-red-400">{deleteMutation.error.message}</p>
            ) : null}
          </>
        );
      })()}
    </div>
  );
}

function AddEventForm({
  onSubmit,
  onCancel,
  loading,
}: {
  onSubmit: (data: {
    label: string;
    startedAt: string;
    endedAt: string | null;
    category: string | null;
    ongoing: boolean;
    notes: string | null;
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [label, setLabel] = useState("");
  const [startedAt, setStartedAt] = useState(formatDateYmd());
  const [endedAt, setEndedAt] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [eventType, setEventType] = useState<"point" | "range" | "ongoing">("point");

  return (
    <div className="card p-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="life-event-label" className="text-xs text-subtle block mb-1">
            Label
          </label>
          <input
            id="life-event-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g., Started Whole 30, Got injured, Started creatine"
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground placeholder:text-dim focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <span className="text-xs text-subtle block mb-1">Type</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            {(["point", "range", "ongoing"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setEventType(t)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  eventType === t
                    ? "bg-accent/15 border-border-strong text-foreground"
                    : "bg-accent/10 border-border-strong text-subtle hover:text-foreground"
                }`}
              >
                {t === "point" ? "One-time" : t === "range" ? "Date range" : "Ongoing"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="life-event-category" className="text-xs text-subtle block mb-1">
            Category
          </label>
          <select
            id="life-event-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
          >
            <option value="">None</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="life-event-start-date" className="text-xs text-subtle block mb-1">
            Start date
          </label>
          <input
            id="life-event-start-date"
            type="date"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
          />
        </div>

        {eventType === "range" && (
          <div>
            <label htmlFor="life-event-end-date" className="text-xs text-subtle block mb-1">
              End date
            </label>
            <input
              id="life-event-end-date"
              type="date"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
            />
          </div>
        )}

        <div className="sm:col-span-2">
          <label htmlFor="life-event-notes" className="text-xs text-subtle block mb-1">
            Notes (optional)
          </label>
          <input
            id="life-event-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context"
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground placeholder:text-dim focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded text-subtle hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!label || !startedAt || loading}
          onClick={() =>
            onSubmit({
              label,
              startedAt,
              endedAt: eventType === "range" && endedAt ? endedAt : null,
              category: category || null,
              ongoing: eventType === "ongoing",
              notes: notes || null,
            })
          }
          className="text-xs px-4 py-1.5 rounded bg-blue-800 text-blue-100 hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function EventAnalysis({
  event,
  analysis,
  loading,
  windowDays,
  onWindowChange,
  onDelete,
  deleting,
}: {
  event: LifeEvent;
  analysis: EventAnalysisData | null;
  loading: boolean;
  windowDays: number;
  onWindowChange: (days: number) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const units = useUnitConverter();
  if (loading) {
    return <div className="h-32 rounded-lg bg-skeleton animate-pulse" />;
  }
  if (!analysis) return null;

  // API returns numeric columns as strings — coerce to numbers
  const numify = (row: AnalysisMetric | undefined): AnalysisMetric | undefined => {
    if (!row) return undefined;
    const out: Record<string, string | number | null> = { period: row.period };
    for (const [k, v] of Object.entries(row)) {
      if (k === "period") continue;
      out[k] = v != null ? Number(v) : null;
    }
    return analysisMetricSchema.parse(out);
  };

  const before = {
    metrics: numify(analysis.metrics.find((m) => m.period === "before")),
    sleep: numify(analysis.sleep.find((m) => m.period === "before")),
    body: numify(analysis.bodyComp.find((m) => m.period === "before")),
  };
  const after = {
    metrics: numify(analysis.metrics.find((m) => m.period === "after")),
    sleep: numify(analysis.sleep.find((m) => m.period === "after")),
    body: numify(analysis.bodyComp.find((m) => m.period === "after")),
  };

  const periodLabel = event.ended_at ? "During" : event.ongoing ? "Since" : "After";

  return (
    <div className="card p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            {categoryIcon(event.category)} {event.label}
          </h3>
          <p className="mt-0.5 break-words text-xs text-subtle">
            {formatDate(event.started_at)}
            {event.ended_at
              ? ` — ${formatDate(event.ended_at)}`
              : event.ongoing
                ? " — ongoing"
                : ""}
            {event.notes && ` · ${event.notes}`}
          </p>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
            <span className="text-xs text-dim">Window:</span>
            <div className="grid grid-cols-4 gap-1.5 sm:flex">
              {[14, 30, 60, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => onWindowChange(days)}
                  className={`w-full text-xs px-2 py-0.5 rounded transition-colors sm:w-auto ${
                    windowDays === days
                      ? "bg-accent/15 text-foreground"
                      : "text-dim hover:text-muted"
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="w-full text-xs text-red-800 hover:text-red-500 transition-colors sm:w-auto"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      {/* Comparison grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <CompareCard
          label="Resting HR"
          before={before.metrics?.avg_resting_hr}
          after={after.metrics?.avg_resting_hr}
          periodLabel={periodLabel}
          lowerBetter
        />
        <CompareCard
          label="Heart Rate Variability (HRV)"
          before={before.metrics?.avg_hrv}
          after={after.metrics?.avg_hrv}
          periodLabel={periodLabel}
          formatValue={formatHRV}
        />
        <CompareCard
          label="Steps"
          before={before.metrics?.avg_steps}
          after={after.metrics?.avg_steps}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Sleep"
          before={before.sleep?.avg_sleep_min}
          after={after.sleep?.avg_sleep_min}
          periodLabel={periodLabel}
          formatValue={(value) => (value == null ? "—" : formatDurationMinutes(value))}
        />
        <CompareCard
          label="Deep Sleep"
          before={before.sleep?.avg_deep_min}
          after={after.sleep?.avg_deep_min}
          periodLabel={periodLabel}
          formatValue={(value) => (value == null ? "—" : formatDurationMinutes(value))}
        />
        <CompareCard
          label="Weight"
          before={before.body?.avg_weight}
          after={after.body?.avg_weight}
          periodLabel={periodLabel}
          lowerBetter
          formatValue={(value) =>
            value == null ? "—" : formatMeasurementText(units.formatWeight(value))
          }
        />
        <CompareCard
          label="Body Fat"
          before={before.body?.avg_body_fat}
          after={after.body?.avg_body_fat}
          periodLabel={periodLabel}
          lowerBetter
          formatValue={formatBodyCompositionPercent}
        />
      </div>

      <p className="text-[11px] text-dim">
        Comparing {windowDays} days before vs. {periodLabel.toLowerCase()}. Before:{" "}
        {before.metrics?.days ?? 0} days of metrics, {before.sleep?.nights ?? 0} nights of sleep,{" "}
        {before.body?.measurements ?? 0} body measurements.
        {periodLabel}: {after.metrics?.days ?? 0} days, {after.sleep?.nights ?? 0} nights,{" "}
        {after.body?.measurements ?? 0} measurements.
      </p>
    </div>
  );
}

function CompareCard({
  label,
  before,
  after,
  periodLabel,
  lowerBetter,
  formatValue,
}: {
  label: string;
  before: number | null | undefined;
  after: number | null | undefined;
  periodLabel: string;
  lowerBetter?: boolean;
  formatValue?: (value: number | null | undefined) => string;
}) {
  if (before == null && after == null) return null;

  const diff = before != null && after != null ? after - before : null;
  const pctDiff =
    diff != null && before != null && before !== 0 ? (diff / Math.abs(before)) * 100 : null;
  const improved = diff != null ? (lowerBetter ? diff < 0 : diff > 0) : null;

  return (
    <div className="rounded border border-border bg-page p-2.5">
      <p className="text-[10px] text-dim uppercase tracking-wider mb-1.5">{label}</p>
      <div className="flex items-baseline gap-2">
        <div className="text-center">
          <p className="text-[10px] text-dim">Before</p>
          <p className="text-sm tabular-nums text-muted">
            {before != null ? formatCompareValue(before, formatValue) : "—"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-dim">{periodLabel}</p>
          <p className="text-sm tabular-nums text-foreground font-medium">
            {after != null ? formatCompareValue(after, formatValue) : "—"}
          </p>
        </div>
        {pctDiff != null && (
          <span
            className={`text-[10px] tabular-nums font-medium ${
              improved ? "text-emerald-500" : "text-red-500"
            }`}
          >
            {pctDiff > 0 ? "+" : ""}
            {formatNumber(pctDiff, 0)}%
          </span>
        )}
      </div>
    </div>
  );
}

function categoryIcon(category: string | null): string {
  switch (category) {
    case "diet":
      return "\u{1F957}";
    case "supplement":
      return "\u{1F48A}";
    case "injury":
      return "\u{1FA79}";
    case "lifestyle":
      return "\u{1F3E0}";
    case "training":
      return "\u{1F3CB}";
    default:
      return "\u{1F4CD}";
  }
}

function formatDate(d: string): string {
  return formatDateMedium(d);
}

function fmtNum(v: number): string {
  if (Number.isInteger(v) || Math.abs(v) >= 100) return Math.round(v).toLocaleString();
  return formatNumber(v);
}

function formatCompareValue(
  value: number,
  formatValue: ((value: number | null | undefined) => string) | undefined,
): string {
  return formatValue ? formatValue(value) : fmtNum(value);
}
