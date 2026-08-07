import { useMemo, useRef, useState } from "react";
import { z } from "zod";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ModalDialog, ModalDialogTitle } from "./ModalDialog.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function AddJournalEntryModal({ isOpen, onClose, onSuccess }: AddJournalEntryModalProps) {
  const questionsQuery = trpc.journal.questions.useQuery();
  const createMutation = trpc.journal.create.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess,
    onError: (error) => {
      captureException(error, { operation: "journal.create" });
    },
  });

  const questions = useMemo(() => {
    if (!questionsQuery.data) return [];
    return z.array(questionSchema).parse(questionsQuery.data);
  }, [questionsQuery.data]);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [date, setDate] = useState(todayString());
  const [answerNumeric, setAnswerNumeric] = useState<string>("");
  const [answerText, setAnswerText] = useState("");
  const [booleanValue, setBooleanValue] = useState(false);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const selectedQuestion = useMemo(
    () => questions.find((question) => question.slug === selectedSlug),
    [questions, selectedSlug],
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
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

  return (
    <ModalDialog
      open={isOpen}
      onClose={onClose}
      closeOnInteractOutside
      initialFocusRef={dateInputRef}
      overlayClassName="bg-black/60"
      contentClassName="bg-surface-solid rounded-xl p-6 w-[calc(100%-2rem)] max-w-md shadow-xl"
    >
      <ModalDialogTitle className="text-lg font-semibold text-foreground mb-4">
        Add Journal Entry
      </ModalDialogTitle>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="journal-date" className="block text-sm font-medium text-muted mb-1">
            Date
          </label>
          <input
            ref={dateInputRef}
            id="journal-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
          />
        </div>

        {questionsQuery.isLoading && questionsQuery.data === undefined ? (
          <QueryStatePanel variant="loading" height={96} />
        ) : null}

        {questionsQuery.error ? (
          <QueryStatePanel
            error={questionsQuery.error}
            height={96}
            onRetry={() => void questionsQuery.refetch()}
            retryLabel="Retry journal questions"
            retrying={questionsQuery.isFetching}
          />
        ) : null}

        {questionsQuery.data !== undefined ? (
          <div>
            <label htmlFor="journal-question" className="block text-sm font-medium text-muted mb-1">
              Question
            </label>
            <select
              id="journal-question"
              value={selectedSlug}
              onChange={(event) => {
                setSelectedSlug(event.target.value);
                setAnswerNumeric("");
                setAnswerText("");
                setBooleanValue(false);
              }}
              className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
            >
              <option value="">Select a question...</option>
              {questions.map((question) => (
                <option key={question.slug} value={question.slug}>
                  {question.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {selectedQuestion ? (
          <div>
            <label htmlFor="journal-answer" className="block text-sm font-medium text-muted mb-1">
              Answer
            </label>

            {selectedQuestion.data_type === "boolean" ? (
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
            ) : null}

            {selectedQuestion.data_type === "numeric" ? (
              <input
                id="journal-answer"
                type="number"
                step="any"
                value={answerNumeric}
                onChange={(event) => setAnswerNumeric(event.target.value)}
                placeholder={selectedQuestion.unit ? `Value (${selectedQuestion.unit})` : "Value"}
                className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm"
              />
            ) : null}

            {selectedQuestion.data_type === "text" ? (
              <textarea
                id="journal-answer"
                value={answerText}
                onChange={(event) => setAnswerText(event.target.value)}
                placeholder="Your answer..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-foreground text-sm resize-none"
              />
            ) : null}
          </div>
        ) : null}

        {createMutation.error ? (
          <p className="text-xs text-red-400">{createMutation.error.message}</p>
        ) : null}

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
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-on-accent disabled:opacity-50"
          >
            {createMutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
