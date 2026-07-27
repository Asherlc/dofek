import { formatDateLong } from "@dofek/format/format";
import { chartColors, statusColors } from "@dofek/scoring/colors";
import { useMemo, useState } from "react";
import { z } from "zod";
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
  const [days, setDays] = useState<TimeRangeDays>(30);

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
          <TimeRangeSelector days={days} onChange={setDays} />
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
  provider_id: z.string(),
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
  const isManual = entry.provider_id === "dofek";

  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <span className="text-sm text-foreground">{entry.display_name}</span>
        <AnswerDisplay entry={entry} />
      </div>
      <div className="flex items-center gap-2">
        {!isManual && <span className="text-xs text-dim">{entry.provider_id}</span>}
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
  const questionsQuery = trpc.journal.questions.useQuery();
  const entriesQuery = trpc.journal.entries.useQuery(selectedRangeQueryInput(days));

  const questions = useMemo(() => {
    if (!questionsQuery.data) return [];
    return z
      .array(
        z.object({
          slug: z.string(),
          display_name: z.string(),
          category: z.string(),
          data_type: z.string(),
          unit: z.string().nullable(),
          sort_order: z.coerce.number(),
        }),
      )
      .parse(questionsQuery.data);
  }, [questionsQuery.data]);

  // Only chart numeric questions that have data
  const entries = useMemo(() => {
    if (!entriesQuery.data) return [];
    return z.array(entrySchema).parse(entriesQuery.data);
  }, [entriesQuery.data]);

  const numericQuestionSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const entry of entries) {
      if (entry.answer_numeric !== null) {
        slugs.add(entry.question_slug);
      }
    }
    return slugs;
  }, [entries]);

  const chartableQuestions = useMemo(
    () => questions.filter((q) => numericQuestionSlugs.has(q.slug)),
    [questions, numericQuestionSlugs],
  );

  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());

  // Auto-select first 3 chartable questions if none selected
  const effectiveSlugs = useMemo(() => {
    if (selectedSlugs.size > 0) return selectedSlugs;
    return new Set(chartableQuestions.slice(0, 3).map((question) => question.slug));
  }, [selectedSlugs, chartableQuestions]);

  const series = useMemo(() => {
    return [...effectiveSlugs].map((slug, index) => {
      const question = questions.find((candidate) => candidate.slug === slug);
      const data: [string, number | null][] = entries
        .filter((entry) => entry.question_slug === slug && entry.answer_numeric !== null)
        .map((entry) => [entry.date, entry.answer_numeric]);
      return {
        name: question?.display_name ?? slug,
        data,
        color: TREND_COLORS[index % TREND_COLORS.length],
      };
    });
  }, [effectiveSlugs, entries, questions]);

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

  if (
    (questionsQuery.isLoading && questionsQuery.data === undefined) ||
    (entriesQuery.isLoading && entriesQuery.data === undefined)
  ) {
    return <QueryStatePanel variant="loading" height={96} />;
  }

  if (
    (questionsQuery.error && questionsQuery.data === undefined) ||
    (entriesQuery.error && entriesQuery.data === undefined)
  ) {
    return (
      <div className="space-y-3">
        {questionsQuery.error && questionsQuery.data === undefined ? (
          <JournalQueryError
            error={questionsQuery.error}
            height={96}
            label="Retry journal questions"
            refetch={questionsQuery.refetch}
            retrying={questionsQuery.isFetching}
          />
        ) : null}
        {entriesQuery.error && entriesQuery.data === undefined ? (
          <JournalQueryError
            error={entriesQuery.error}
            height={96}
            label="Retry journal entries"
            refetch={entriesQuery.refetch}
            retrying={entriesQuery.isFetching}
          />
        ) : null}
      </div>
    );
  }

  const backgroundErrors = (
    <>
      {questionsQuery.error ? (
        <JournalQueryError
          error={questionsQuery.error}
          height={72}
          label="Retry journal questions"
          refetch={questionsQuery.refetch}
          retrying={questionsQuery.isFetching}
        />
      ) : null}
      {entriesQuery.error ? (
        <JournalQueryError
          error={entriesQuery.error}
          height={72}
          label="Retry journal entries"
          refetch={entriesQuery.refetch}
          retrying={entriesQuery.isFetching}
        />
      ) : null}
    </>
  );

  if (chartableQuestions.length === 0) {
    return (
      <div className="space-y-3">
        {backgroundErrors}
        <p className="text-dim text-sm text-center py-8">No numeric journal data to chart.</p>
      </div>
    );
  }

  return (
    <div>
      {backgroundErrors}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {chartableQuestions.map((q) => (
          <button
            key={q.slug}
            type="button"
            className={`px-2.5 py-1 rounded-full text-xs font-medium ${effectiveSlugs.has(q.slug) ? "bg-accent/15 text-accent" : "bg-surface-hover text-muted hover:text-foreground"}`}
            onClick={() => toggleSlug(q.slug)}
          >
            {q.display_name}
          </button>
        ))}
      </div>

      <TimeSeriesChart series={series} height={280} loading={false} />
    </div>
  );
}
