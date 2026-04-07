// ============================================================
// Journal parsing — response shape discovered empirically
// ============================================================

export interface ParsedJournalEntry {
  question: string; // e.g. "caffeine", "alcohol", "melatonin"
  answerText: string | null;
  answerNumeric: number | null;
  impactScore: number | null;
  date: Date;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const val = obj[key];
  return Array.isArray(val) ? val : undefined;
}

function toRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val));
  }
  return null;
}

/**
 * Parse the behavior-impact-service response into health_event entries.
 * The response shape isn't documented — this handles several possibilities:
 * - Array of journal entry objects
 * - Wrapped object with entries under a known key
 * - Individual entry with nested answers
 */
export function parseJournalResponse(raw: unknown): ParsedJournalEntry[] {
  if (!raw || typeof raw !== "object") return [];

  // Unwrap if wrapped in a known key
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const obj = toRecord(raw);
    if (!obj) return [];
    // Try common wrapper keys
    const wrapped =
      obj.impacts ?? obj.entries ?? obj.data ?? obj.results ?? obj.journal ?? obj.records;
    if (Array.isArray(wrapped)) {
      items = wrapped;
    } else {
      // Single object — wrap it
      items = [raw];
    }
  }

  const entries: ParsedJournalEntry[] = [];
  for (const item of items) {
    const obj = toRecord(item);
    if (!obj) continue;

    // Try to extract a date
    const dateStr =
      getString(obj, "date") ??
      getString(obj, "created_at") ??
      getString(obj, "cycle_start") ??
      getString(obj, "start") ??
      getString(obj, "day");
    const date = dateStr ? new Date(dateStr) : null;
    if (!date || Number.isNaN(date.getTime())) continue;

    // Check if it has nested answers/behaviors
    const answers =
      getArray(obj, "answers") ??
      getArray(obj, "behaviors") ??
      getArray(obj, "items") ??
      getArray(obj, "journal_entries");

    if (Array.isArray(answers)) {
      for (const answer of answers) {
        const answerRecord = toRecord(answer);
        if (!answerRecord) continue;
        const question =
          getString(answerRecord, "name") ??
          getString(answerRecord, "behavior") ??
          getString(answerRecord, "question") ??
          getString(answerRecord, "type") ??
          "unknown";
        const answerNumeric =
          typeof answerRecord.value === "number"
            ? answerRecord.value
            : typeof answerRecord.score === "number"
              ? answerRecord.score
              : null;
        const answerText =
          typeof answerRecord.answer === "string"
            ? answerRecord.answer
            : typeof answerRecord.response === "string"
              ? answerRecord.response
              : typeof answerRecord.value === "string"
                ? answerRecord.value
                : null;
        const impactScore =
          typeof answerRecord.impact === "number"
            ? answerRecord.impact
            : typeof answerRecord.impact_score === "number"
              ? answerRecord.impact_score
              : null;

        entries.push({
          question: question.toLowerCase().replace(/\s+/g, "_"),
          answerText,
          answerNumeric,
          impactScore,
          date,
        });
      }
    } else {
      // Flat entry — use available fields
      const question =
        getString(obj, "name") ?? getString(obj, "behavior") ?? getString(obj, "type") ?? "journal";
      const answerNumeric =
        typeof obj.value === "number"
          ? obj.value
          : typeof obj.score === "number"
            ? obj.score
            : null;
      const answerText =
        typeof obj.answer === "string"
          ? obj.answer
          : typeof obj.response === "string"
            ? obj.response
            : null;
      const impactScore =
        typeof obj.impact === "number"
          ? obj.impact
          : typeof obj.impact_score === "number"
            ? obj.impact_score
            : null;

      entries.push({
        question: question.toLowerCase().replace(/\s+/g, "_"),
        answerText,
        answerNumeric,
        impactScore,
        date,
      });
    }
  }
  return entries;
}
