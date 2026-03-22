import { useMemo, useState } from "react";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";

interface AddJournalEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const questionSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  sort_order: z.coerce.number(),
});

function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function AddJournalEntryModal({ isOpen, onClose, onSuccess }: AddJournalEntryModalProps) {
  const questionsQuery = trpc.journal.questions.useQuery();
  const createMutation = trpc.journal.create.useMutation({ onSuccess });

  const questions = useMemo(() => {
    if (!questionsQuery.data) return [];
    return z.array(questionSchema).parse(questionsQuery.data);
  }, [questionsQuery.data]);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [date, setDate] = useState(todayString());
  const [answerNumeric, setAnswerNumeric] = useState<string>("");
  const [answerText, setAnswerText] = useState("");
  const [booleanValue, setBooleanValue] = useState(false);

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.slug === selectedSlug),
    [questions, selectedSlug],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSlug || !date) return;

    let numericValue: number | null = null;
    let textValue: string | null = null;

    if (selectedQuestion?.data_type === "boolean") {
      numericValue = booleanValue ? 1 : 0;
    } else if (selectedQuestion?.data_type === "numeric") {
      numericValue = answerNumeric ? Number(answerNumeric) : null;
    } else {
      textValue = answerText || null;
    }

    createMutation.mutate({
      date,
      questionSlug: selectedSlug,
      answerNumeric: numericValue,
      answerText: textValue,
    });
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        aria-label="Close modal overlay"
      />
      <div className="relative bg-surface-solid rounded-xl p-6 w-full max-w-md shadow-xl">
        <h3 className="text-lg font-semibold text-foreground mb-4">Add Journal Entry</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="journal-date" className="block text-sm font-medium text-muted mb-1">
              Date
            </label>
            <input
              id="journal-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
            />
          </div>

          <div>
            <label htmlFor="journal-question" className="block text-sm font-medium text-muted mb-1">
              Question
            </label>
            <select
              id="journal-question"
              value={selectedSlug}
              onChange={(e) => {
                setSelectedSlug(e.target.value);
                setAnswerNumeric("");
                setAnswerText("");
                setBooleanValue(false);
              }}
              className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
            >
              <option value="">Select a question...</option>
              {questions.map((q) => (
                <option key={q.slug} value={q.slug}>
                  {q.display_name}
                </option>
              ))}
            </select>
          </div>

          {selectedQuestion && (
            <div>
              <label htmlFor="journal-answer" className="block text-sm font-medium text-muted mb-1">
                Answer
              </label>

              {selectedQuestion.data_type === "boolean" && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={`px-4 py-2 rounded-lg text-sm font-medium ${!booleanValue ? "bg-accent/15 text-accent" : "bg-surface-hover text-muted"}`}
                    onClick={() => setBooleanValue(false)}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    className={`px-4 py-2 rounded-lg text-sm font-medium ${booleanValue ? "bg-accent/15 text-accent" : "bg-surface-hover text-muted"}`}
                    onClick={() => setBooleanValue(true)}
                  >
                    Yes
                  </button>
                </div>
              )}

              {selectedQuestion.data_type === "numeric" && (
                <input
                  id="journal-answer"
                  type="number"
                  step="any"
                  value={answerNumeric}
                  onChange={(e) => setAnswerNumeric(e.target.value)}
                  placeholder={selectedQuestion.unit ? `Value (${selectedQuestion.unit})` : "Value"}
                  className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
                />
              )}

              {selectedQuestion.data_type === "text" && (
                <textarea
                  id="journal-answer"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="Your answer..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm resize-none"
                />
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedSlug || createMutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white disabled:opacity-50"
            >
              {createMutation.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
