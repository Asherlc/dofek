import { useMemo, useState } from "react";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";
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

export function JournalPanel() {
  const [tab, setTab] = useState<Tab>("log");
  const [days, setDays] = useState(30);

  return (
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

      {tab === "log" ? <JournalLog days={days} /> : <JournalTrends days={days} />}
    </div>
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
  impact_score: z.coerce.number().nullable(),
});

type JournalEntry = z.infer<typeof entrySchema>;

function JournalLog({ days }: { days: number }) {
  const [showModal, setShowModal] = useState(false);
  const utils = trpc.useUtils();
  const entriesQuery = trpc.journal.entries.useQuery({ days });
  const deleteMutation = trpc.journal.delete.useMutation({
    onSuccess: () => utils.journal.entries.invalidate(),
  });

  const entries = useMemo(() => {
    if (!entriesQuery.data) return [];
    return z.array(entrySchema).parse(entriesQuery.data);
  }, [entriesQuery.data]);

  // Group entries by date
  const grouped = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const existing = map.get(entry.date) ?? [];
      existing.push(entry);
      map.set(entry.date, existing);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

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

      {entriesQuery.isLoading && <p className="text-muted text-sm text-center py-8">Loading...</p>}

      {!entriesQuery.isLoading && entries.length === 0 && (
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
  const dateDisplay = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

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
        {entry.impact_score !== null && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${entry.impact_score >= 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}
          >
            {entry.impact_score > 0 ? "+" : ""}
            {entry.impact_score.toFixed(1)} impact
          </span>
        )}
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
      <span
        className={`text-xs px-1.5 py-0.5 rounded font-medium ${isYes ? "bg-accent/15 text-accent" : "bg-surface-hover text-dim"}`}
      >
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
  "#6366f1", // indigo
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#a855f7", // purple
];

function JournalTrends({ days }: { days: number }) {
  const questionsQuery = trpc.journal.questions.useQuery();
  const entriesQuery = trpc.journal.entries.useQuery({ days });

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

  if (questionsQuery.isLoading || entriesQuery.isLoading) {
    return <p className="text-muted text-sm text-center py-8">Loading...</p>;
  }

  if (chartableQuestions.length === 0) {
    return <p className="text-dim text-sm text-center py-8">No numeric journal data to chart.</p>;
  }

  return (
    <div>
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
