import { formatDateLong, formatDateYmd } from "@dofek/format/format";
import { chartColors, statusColors } from "@dofek/scoring/colors";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { selectedRangeQueryInput, type TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";
import { ChartRangeProvider } from "./DofekChart.tsx";
import { PaginationControls } from "./PaginationControls.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";
import { TimeRangeSelector } from "./TimeRangeSelector.tsx";
import { TimeSeriesChart } from "./TimeSeriesChart.tsx";

const CATEGORY_LABELS: Record<string, string> = {
  substance: "Substances",
  activity: "Activities",
  wellness: "Wellness",
  nutrition: "Nutrition",
  custom: "Custom",
};

const CATEGORY_ORDER = ["wellness", "activity", "substance", "nutrition", "custom"];

type Tab = "log" | "trends";

function JournalQueryError({
  error,
  height,
  label,
  refetch,
  retrying,
}: {
  error: unknown;
  height: number;
  label: string;
  refetch: () => Promise<unknown>;
  retrying: boolean;
}) {
  return (
    <QueryStatePanel
      error={error}
      height={height}
      onRetry={() => void refetch()}
      retryLabel={label}
      retrying={retrying}
    />
  );
}

export function JournalPanel() {
  const [tab, setTab] = useState<Tab>("log");
  const { days, description, setDays } = useTimeRangePreference("behavior");

  return (
    <ChartRangeProvider days={days}>
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <button
              type="button"
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === "log" ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
              onClick={() => setTab("log")}
            >
              Log
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === "trends" ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
              onClick={() => setTab("trends")}
            >
              Trends
            </button>
          </div>
          <TimeRangeSelector days={days} description={description} onChange={setDays} />
        </div>

        {tab === "log" ? (
          <JournalLog key={days ?? "all"} days={days} />
        ) : (
          <JournalTrends days={days} />
        )}
      </div>
    </ChartRangeProvider>
  );
}

// ---- Log Tab ----

const entrySchema = z.object({
  id: z.string(),
  date: z.string(),
  source: z.object({
    providerId: z.string(),
    label: z.string(),
  }),
  question_slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  answer_text: z.string().nullable(),
  answer_numeric: z.coerce.number().nullable(),
});

type JournalEntry = z.infer<typeof entrySchema>;
const JOURNAL_PAGE_SIZE = 20;

function JournalLog({ days }: { days: TimeRangeDays }) {
  const [showModal, setShowModal] = useState(false);
  const [page, setPage] = useState(0);
  const utils = trpc.useUtils();
  const entriesQuery = trpc.journal.entries.useQuery(selectedRangeQueryInput(days));
  const deleteMutation = trpc.journal.delete.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: () => utils.journal.entries.invalidate(),
    onError: (error) => {
      captureException(error, { operation: "journal.delete" });
    },
  });

  const entries = useMemo(() => {
    if (!entriesQuery.data) return [];
    return z.array(entrySchema).parse(entriesQuery.data);
  }, [entriesQuery.data]);

  const totalPages = Math.ceil(entries.length / JOURNAL_PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages - 1, 0));
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.date.localeCompare(a.date)),
    [entries],
  );
  const visibleEntries = useMemo(
    () =>
      sortedEntries.slice(currentPage * JOURNAL_PAGE_SIZE, (currentPage + 1) * JOURNAL_PAGE_SIZE),
    [currentPage, sortedEntries],
  );

  // Group visible entries by date.
  const grouped = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of visibleEntries) {
      const existing = map.get(entry.date) ?? [];
      existing.push(entry);
      map.set(entry.date, existing);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [visibleEntries]);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          type="button"
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-accent/15 text-accent hover:bg-accent/25"
          onClick={() => setShowModal(true)}
        >
          + Add Entry
        </button>
      </div>

      {entriesQuery.isLoading && entriesQuery.data === undefined && (
        <QueryStatePanel variant="loading" height={96} />
      )}

      {entriesQuery.error && entriesQuery.data === undefined && (
        <JournalQueryError
          error={entriesQuery.error}
          height={96}
          label="Retry journal entries"
          refetch={entriesQuery.refetch}
          retrying={entriesQuery.isFetching}
        />
      )}

      {entriesQuery.error && entriesQuery.data !== undefined && (
        <JournalQueryError
          error={entriesQuery.error}
          height={72}
          label="Retry journal entries"
          refetch={entriesQuery.refetch}
          retrying={entriesQuery.isFetching}
        />
      )}

      {!entriesQuery.isLoading && entriesQuery.data !== undefined && entries.length === 0 && (
        <p className="text-dim text-sm text-center py-8">No journal entries yet.</p>
      )}

      {grouped.map(([date, dayEntries]) => (
        <DayGroup
          key={date}
          date={date}
          entries={dayEntries}
          onDelete={(id) => deleteMutation.mutate({ id })}
        />
      ))}

      <PaginationControls
        page={currentPage}
        pageSize={JOURNAL_PAGE_SIZE}
        totalItems={entries.length}
        itemLabel="journal entries"
        onPageChange={setPage}
      />

      {deleteMutation.error ? (
        <p className="text-xs text-red-400 mt-3">{deleteMutation.error.message}</p>
      ) : null}

      {showModal && (
        <AddJournalEntryModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSuccess={() => {
            setShowModal(false);
            utils.journal.entries.invalidate();
          }}
        />
      )}
    </div>
  );
}

function DayGroup({
  date,
  entries,
  onDelete,
}: {
  date: string;
  entries: JournalEntry[];
  onDelete: (id: string) => void;
}) {
  const dateDisplay = formatDateLong(date);

  // Group by category
  const byCategory = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const existing = map.get(entry.category) ?? [];
      existing.push(entry);
      map.set(entry.category, existing);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
      category: c,
      entries: map.get(c) ?? [],
    }));
  }, [entries]);

  return (
    <div className="mb-4">
      <h4 className="text-sm font-medium text-muted mb-2">{dateDisplay}</h4>
      <div className="card p-3 space-y-3">
        {byCategory.map(({ category, entries: catEntries }) => (
          <div key={category}>
            <p className="text-xs font-medium text-dim mb-1">
              {CATEGORY_LABELS[category] ?? category}
            </p>
            <div className="space-y-1">
              {catEntries.map((entry) => (
                <JournalEntryRow key={entry.id} entry={entry} onDelete={onDelete} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function JournalEntryRow({
  entry,
  onDelete,
}: {
  entry: JournalEntry;
  onDelete: (id: string) => void;
}) {
  const isManual = entry.source.providerId === "dofek";

  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <span className="text-sm text-foreground">{entry.display_name}</span>
        <AnswerDisplay entry={entry} />
      </div>
      <div className="flex items-center gap-2">
        {!isManual && <JournalSourceDetails source={entry.source} />}
        {isManual && (
          <button
            type="button"
            className="text-xs text-red-400 hover:text-red-300"
            onClick={() => onDelete(entry.id)}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function JournalSourceDetails({ source }: { source: JournalEntry["source"] }) {
  const [expanded, setExpanded] = useState(false);
  const action = expanded ? "Hide" : "Show";

  return (
    <div className="text-right text-xs text-dim">
      <span>{source.label}</span>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${action} technical source details for ${source.label}`}
        className="ml-1 text-[10px] text-subtle underline decoration-dotted underline-offset-2 hover:text-muted"
        onClick={() => setExpanded((current) => !current)}
      >
        Technical details
      </button>
      {expanded && <span className="block text-[10px]">Provider ID: {source.providerId}</span>}
    </div>
  );
}

function AnswerDisplay({ entry }: { entry: JournalEntry }) {
  if (entry.data_type === "boolean") {
    const isYes = entry.answer_numeric !== null && entry.answer_numeric > 0;
    return (
      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-surface-hover text-muted">
        {isYes ? "Yes" : "No"}
      </span>
    );
  }

  if (entry.data_type === "numeric" && entry.answer_numeric !== null) {
    return (
      <span className="text-sm text-muted">
        {entry.answer_numeric}
        {entry.unit ? ` ${entry.unit}` : ""}
      </span>
    );
  }

  if (entry.answer_text) {
    return <span className="text-sm text-muted italic">{entry.answer_text}</span>;
  }

  return null;
}

// ---- Trends Tab ----

const TREND_COLORS = [
  chartColors.blue,
  statusColors.positive,
  chartColors.amber,
  statusColors.danger,
  chartColors.teal,
  chartColors.purple,
];

function JournalTrends({ days }: { days: TimeRangeDays }) {
  const trendsQuery = trpc.journal.trends.useQuery({
    days,
    endDate: formatDateYmd(),
  });
  const evidence = trendsQuery.data;

  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());

  // Auto-select first 3 chartable questions if none selected
  const effectiveSlugs = useMemo(() => {
    if (selectedSlugs.size > 0) return selectedSlugs;
    return new Set(evidence?.series.slice(0, 3).map((series) => series.questionSlug) ?? []);
  }, [selectedSlugs, evidence?.series]);

  const series = useMemo(() => {
    return [...effectiveSlugs].map((slug, index) => {
      const trend = evidence?.series.find((candidate) => candidate.questionSlug === slug);
      const data: [string, number | null][] =
        trend?.points.map((point) => [point.date, point.value]) ?? [];
      const observedDates =
        trend?.points.flatMap((point) => (point.value === null ? [] : [point.date])) ?? [];
      const hasSameDayObservations = new Set(observedDates).size !== observedDates.length;
      const showAsPoints = trend?.dataType === "boolean" || hasSameDayObservations;
      return {
        name: trend?.displayName ?? slug,
        data,
        color: TREND_COLORS[index % TREND_COLORS.length],
        missingDates:
          trend?.points.filter((point) => point.value === null).map((point) => point.date) ?? [],
        accessibilityDescription:
          trend?.dataType === "boolean"
            ? `${trend.displayName} is shown as separate Yes/No points.`
            : hasSameDayObservations
              ? `${trend?.displayName ?? slug} is shown as separate points because multiple sources recorded the same date.`
              : undefined,
        visualization: showAsPoints ? ("point" as const) : ("line" as const),
        formatValue:
          trend?.dataType === "boolean"
            ? (value: number) => formatJournalTrendValue(value, "boolean", trend.unit)
            : undefined,
      };
    });
  }, [effectiveSlugs, evidence?.series]);

  const selectedEvidence = useMemo(
    () => evidence?.series.filter((trend) => effectiveSlugs.has(trend.questionSlug)) ?? [],
    [effectiveSlugs, evidence?.series],
  );

  function toggleSlug(slug: string) {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }

  if (trendsQuery.isLoading && evidence === undefined) {
    return <QueryStatePanel variant="loading" height={96} />;
  }

  if (trendsQuery.error && evidence === undefined) {
    return (
      <JournalQueryError
        error={trendsQuery.error}
        height={96}
        label="Retry journal trends"
        refetch={trendsQuery.refetch}
        retrying={trendsQuery.isFetching}
      />
    );
  }

  if (!evidence) {
    return (
      <QueryStatePanel
        variant="empty"
        height={96}
        message="Journal trend evidence is unavailable."
      />
    );
  }

  if (evidence.series.length === 0) {
    return (
      <div className="space-y-3">
        {trendsQuery.error ? (
          <JournalQueryError
            error={trendsQuery.error}
            height={72}
            label="Retry journal trends"
            refetch={trendsQuery.refetch}
            retrying={trendsQuery.isFetching}
          />
        ) : null}
        <p className="text-dim text-sm text-center py-8">No numeric journal data to chart.</p>
      </div>
    );
  }

  const dateRange = `${formatDateLong(evidence.window.startDate)} – ${formatDateLong(evidence.window.endDate)}`;
  const chartDescription =
    evidence.window.gapRepresentation === "explicit_daily"
      ? `Journal trends from ${formatDateLong(evidence.window.startDate)} to ${formatDateLong(evidence.window.endDate)}. Missing days are gaps in numeric lines and are listed below with exact observations.`
      : `Journal trends from ${formatDateLong(evidence.window.startDate)} to ${formatDateLong(evidence.window.endDate)}. Missing days are summarized by count for All history; choose a finite range to inspect exact missing dates.`;

  return (
    <div className="space-y-4">
      {trendsQuery.error ? (
        <JournalQueryError
          error={trendsQuery.error}
          height={72}
          label="Retry journal trends"
          refetch={trendsQuery.refetch}
          retrying={trendsQuery.isFetching}
        />
      ) : null}
      <div className="rounded-lg border border-border bg-surface-hover/40 p-3 space-y-1">
        <p className="text-sm font-medium text-foreground">{dateRange}</p>
        <p className="text-xs text-muted">{evidence.statement}</p>
        <p className="text-xs text-muted">{evidence.uncertainty.statement}</p>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {evidence.series.map((trend) => (
          <button
            key={trend.questionSlug}
            type="button"
            className={`px-2.5 py-1 rounded-full text-xs font-medium ${effectiveSlugs.has(trend.questionSlug) ? "bg-accent/15 text-accent" : "bg-surface-hover text-muted hover:text-foreground"}`}
            onClick={() => toggleSlug(trend.questionSlug)}
          >
            {trend.displayName}
          </button>
        ))}
      </div>

      <TimeSeriesChart
        series={series}
        height={280}
        loading={false}
        accessibilityDescription={chartDescription}
      />

      <div className="grid gap-3 md:grid-cols-2">
        {selectedEvidence.map((trend) => {
          const observations = trend.points.filter(
            (
              point,
            ): point is typeof point & {
              value: number;
              source: NonNullable<typeof point.source>;
            } => point.value !== null && point.source !== null,
          );
          const missingDates = trend.points
            .filter((point) => point.value === null)
            .map((point) => formatDateLong(point.date));
          return (
            <section
              key={trend.questionSlug}
              className="rounded-lg border border-border bg-surface p-3 space-y-2"
            >
              <h4 className="text-sm font-medium text-foreground">{trend.displayName}</h4>
              <p className="text-xs text-muted">{trend.statement}</p>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer font-medium text-foreground">
                  Exact values ({observations.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {observations.map((point) => (
                    <li key={`${point.date}-${point.source.providerId}`}>
                      <span className="font-medium">{formatDateLong(point.date)}:</span>{" "}
                      {formatJournalTrendValue(point.value, trend.dataType, trend.unit)} ·{" "}
                      {point.source.label}
                    </li>
                  ))}
                </ul>
              </details>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer font-medium text-foreground">
                  Missing days ({trend.missingDayCount})
                </summary>
                <p className="mt-2">
                  {evidence.window.gapRepresentation === "explicit_daily"
                    ? `Missing: ${missingDates.join(", ") || "None"}`
                    : `Missing-day dates are summarized by count for All history: ${trend.missingDayCount} days. Choose a finite range to inspect exact missing dates.`}
                </p>
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function formatJournalTrendValue(
  value: number,
  dataType: "boolean" | "numeric",
  unit: string | null,
): string {
  if (dataType === "boolean") {
    return value === 1 ? "Yes" : value === 0 ? "No" : String(value);
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}
