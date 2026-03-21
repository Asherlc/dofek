import { useState } from "react";
import { z } from "zod";
import { formatNumber } from "../lib/format.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertWeight, weightLabel } from "../lib/units.ts";

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
  avg_active_energy: z.number().optional(),
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

export function LifeEventsPanel() {
  const [showForm, setShowForm] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);

  const utils = trpc.useUtils();
  const events = trpc.lifeEvents.list.useQuery();
  const createMutation = trpc.lifeEvents.create.useMutation({
    onSuccess: () => {
      utils.lifeEvents.list.invalidate();
      setShowForm(false);
    },
  });
  const deleteMutation = trpc.lifeEvents.delete.useMutation({
    onSuccess: () => {
      utils.lifeEvents.list.invalidate();
      setSelectedEvent(null);
    },
  });
  const analysis = trpc.lifeEvents.analyze.useQuery(
    { id: selectedEvent ?? "", windowDays },
    { enabled: !!selectedEvent },
  );

  const eventList = z.array(lifeEventSchema).parse(events.data ?? []);

  return (
    <div className="space-y-4">
      {/* Event list + add button */}
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {eventList.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelectedEvent(selectedEvent === e.id ? null : e.id)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                selectedEvent === e.id
                  ? "bg-blue-900/50 border-blue-700 text-blue-300"
                  : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
              }`}
            >
              <span className="mr-1.5">{categoryIcon(e.category)}</span>
              {e.label}
              <span className="ml-1.5 text-zinc-600">
                {formatDate(e.started_at)}
                {e.ended_at ? ` — ${formatDate(e.ended_at)}` : e.ongoing ? " — now" : ""}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          + Add event
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <AddEventForm
          onSubmit={(data) => createMutation.mutate(data)}
          onCancel={() => setShowForm(false)}
          loading={createMutation.isPending}
        />
      )}

      {/* Analysis */}
      {(() => {
        if (!selectedEvent || eventList.length === 0) return null;
        const foundEvent = eventList.find((e) => e.id === selectedEvent);
        const fallbackEvent = eventList[0];
        const event = foundEvent ?? fallbackEvent;
        if (!event) return null;
        return (
          <EventAnalysis
            event={event}
            analysis={eventAnalysisDataSchema.nullable().parse(analysis.data ?? null)}
            loading={analysis.isLoading}
            windowDays={windowDays}
            onWindowChange={setWindowDays}
            onDelete={() => deleteMutation.mutate({ id: selectedEvent })}
          />
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
  const [startedAt, setStartedAt] = useState(new Date().toISOString().slice(0, 10));
  const [endedAt, setEndedAt] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [eventType, setEventType] = useState<"point" | "range" | "ongoing">("point");

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label htmlFor="life-event-label" className="text-xs text-zinc-500 block mb-1">
            Label
          </label>
          <input
            id="life-event-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g., Started Whole 30, Got injured, Started creatine"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>

        <div>
          <span className="text-xs text-zinc-500 block mb-1">Type</span>
          <div className="flex gap-2">
            {(["point", "range", "ongoing"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setEventType(t)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  eventType === t
                    ? "bg-zinc-700 border-zinc-600 text-zinc-100"
                    : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t === "point" ? "One-time" : t === "range" ? "Date range" : "Ongoing"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="life-event-category" className="text-xs text-zinc-500 block mb-1">
            Category
          </label>
          <select
            id="life-event-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
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
          <label htmlFor="life-event-start-date" className="text-xs text-zinc-500 block mb-1">
            Start date
          </label>
          <input
            id="life-event-start-date"
            type="date"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
          />
        </div>

        {eventType === "range" && (
          <div>
            <label htmlFor="life-event-end-date" className="text-xs text-zinc-500 block mb-1">
              End date
            </label>
            <input
              id="life-event-end-date"
              type="date"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
            />
          </div>
        )}

        <div className="col-span-2">
          <label htmlFor="life-event-notes" className="text-xs text-zinc-500 block mb-1">
            Notes (optional)
          </label>
          <input
            id="life-event-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
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
}: {
  event: LifeEvent;
  analysis: EventAnalysisData | null;
  loading: boolean;
  windowDays: number;
  onWindowChange: (days: number) => void;
  onDelete: () => void;
}) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return <div className="h-32 rounded-lg bg-zinc-800 animate-pulse" />;
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">
            {categoryIcon(event.category)} {event.label}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {formatDate(event.started_at)}
            {event.ended_at
              ? ` — ${formatDate(event.ended_at)}`
              : event.ongoing
                ? " — ongoing"
                : ""}
            {event.notes && ` · ${event.notes}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-600">Window:</span>
            {[14, 30, 60, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onWindowChange(d)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  windowDays === d
                    ? "bg-zinc-700 text-zinc-200"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-red-800 hover:text-red-500 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Comparison grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <CompareCard
          label="Resting HR"
          unit="bpm"
          before={before.metrics?.avg_resting_hr}
          after={after.metrics?.avg_resting_hr}
          periodLabel={periodLabel}
          lowerBetter
        />
        <CompareCard
          label="HRV"
          unit="ms"
          before={before.metrics?.avg_hrv}
          after={after.metrics?.avg_hrv}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Steps"
          unit=""
          before={before.metrics?.avg_steps}
          after={after.metrics?.avg_steps}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Active Energy"
          unit="kcal"
          before={before.metrics?.avg_active_energy}
          after={after.metrics?.avg_active_energy}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Sleep"
          unit="min"
          before={before.sleep?.avg_sleep_min}
          after={after.sleep?.avg_sleep_min}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Deep Sleep"
          unit="min"
          before={before.sleep?.avg_deep_min}
          after={after.sleep?.avg_deep_min}
          periodLabel={periodLabel}
        />
        <CompareCard
          label="Weight"
          unit={weightLabel(unitSystem)}
          before={
            before.body?.avg_weight != null
              ? convertWeight(Number(before.body.avg_weight), unitSystem)
              : undefined
          }
          after={
            after.body?.avg_weight != null
              ? convertWeight(Number(after.body.avg_weight), unitSystem)
              : undefined
          }
          periodLabel={periodLabel}
          lowerBetter
        />
        <CompareCard
          label="Body Fat"
          unit="%"
          before={before.body?.avg_body_fat}
          after={after.body?.avg_body_fat}
          periodLabel={periodLabel}
          lowerBetter
        />
      </div>

      <p className="text-[11px] text-zinc-600">
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
  unit,
  before,
  after,
  periodLabel,
  lowerBetter,
}: {
  label: string;
  unit: string;
  before: number | null | undefined;
  after: number | null | undefined;
  periodLabel: string;
  lowerBetter?: boolean;
}) {
  if (before == null && after == null) return null;

  const diff = before != null && after != null ? after - before : null;
  const pctDiff =
    diff != null && before != null && before !== 0 ? (diff / Math.abs(before)) * 100 : null;
  const improved = diff != null ? (lowerBetter ? diff < 0 : diff > 0) : null;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">{label}</p>
      <div className="flex items-baseline gap-2">
        <div className="text-center">
          <p className="text-[10px] text-zinc-600">Before</p>
          <p className="text-sm tabular-nums text-zinc-400">
            {before != null ? fmtNum(before) : "—"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-zinc-600">{periodLabel}</p>
          <p className="text-sm tabular-nums text-zinc-100 font-medium">
            {after != null ? fmtNum(after) : "—"}
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
      {unit && <p className="text-[10px] text-zinc-700 mt-0.5">{unit}</p>}
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
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtNum(v: number): string {
  if (Number.isInteger(v) || Math.abs(v) >= 100) return Math.round(v).toLocaleString();
  return formatNumber(v);
}
