import { type ProviderProvenance, resolveProviderProvenance } from "@dofek/providers/providers";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  currentDateRangePredicate,
  dateWindowEnd,
  dateWindowStartPredicate,
  type RangeDays,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOFEK_PROVIDER_ID = "dofek";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const journalQuestionRowSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  sort_order: z.coerce.number(),
});

const journalEntryRowSchema = z.object({
  id: z.string(),
  date: dateStringSchema,
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

const journalEntryFullRowSchema = z.object({
  id: z.string(),
  date: dateStringSchema,
  provider_id: z.string(),
  user_id: z.string(),
  question_slug: z.string(),
  answer_text: z.string().nullable(),
  answer_numeric: z.coerce.number().nullable(),
  impact_score: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type JournalQuestionRow = z.infer<typeof journalQuestionRowSchema>;
type JournalEntryRow = z.infer<typeof journalEntryRowSchema>;
export type JournalEntryFullRow = z.infer<typeof journalEntryFullRowSchema>;
export type JournalEntryDetail = Omit<JournalEntryRow, "provider_id"> & {
  source: ProviderProvenance;
};

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for journal questions and entries. */
export class JournalRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Ensure the 'dofek' provider row exists (for manual entries). */
  async ensureDofekProvider(): Promise<void> {
    await ensurePushProvider({
      database: this.#db,
      providerId: DOFEK_PROVIDER_ID,
      providerName: "Dofek App",
      userId: this.#userId,
    });
  }

  /** List all available journal questions ordered by sort_order. */
  async listQuestions(): Promise<JournalQuestionRow[]> {
    return executeWithSchema(
      this.#db,
      journalQuestionRowSchema,
      sql`SELECT slug, display_name, category, data_type, unit, sort_order
          FROM fitness.journal_question
          ORDER BY sort_order, display_name`,
    );
  }

  /** Get journal entries for a date range, joined with question metadata. */
  async listEntries(days: RangeDays): Promise<JournalEntryDetail[]> {
    const rows = await executeWithSchema(
      this.#db,
      journalEntryRowSchema,
      sql`SELECT
            je.id,
            je.date,
            je.provider_id,
            je.question_slug,
            jq.display_name,
            jq.category,
            jq.data_type,
            jq.unit,
            je.answer_text,
            je.answer_numeric,
            je.impact_score
          FROM fitness.journal_entry je
          JOIN fitness.journal_question jq ON jq.slug = je.question_slug
          WHERE je.user_id = ${this.#userId}
            ${currentDateRangePredicate(sql`je.date`, days, ">=")}
          ORDER BY je.date DESC, jq.sort_order, jq.display_name`,
    );
    return rows.map(({ provider_id: providerId, ...entry }) => ({
      ...entry,
      source: resolveProviderProvenance(providerId),
    }));
  }

  /** Exact chartable journal observations inside the requested trend window. */
  async listTrendEntries(days: RangeDays, endDate: string): Promise<JournalEntryDetail[]> {
    const rows = await executeWithSchema(
      this.#db,
      journalEntryRowSchema,
      sql`SELECT
            je.id,
            je.date,
            je.provider_id,
            je.question_slug,
            jq.display_name,
            jq.category,
            jq.data_type,
            jq.unit,
            je.answer_text,
            je.answer_numeric,
            je.impact_score
          FROM fitness.journal_entry je
          JOIN fitness.journal_question jq ON jq.slug = je.question_slug
          WHERE je.user_id = ${this.#userId}
            ${dateWindowStartPredicate(sql`je.date`, endDate, days)}
            AND je.date <= ${dateWindowEnd(endDate)}
            AND je.answer_numeric IS NOT NULL
            AND jq.data_type IN ('boolean', 'numeric')
          ORDER BY jq.sort_order, jq.display_name, je.date, je.provider_id`,
    );
    return rows.map(({ provider_id: providerId, ...entry }) => ({
      ...entry,
      source: resolveProviderProvenance(providerId),
    }));
  }

  /** Create (or upsert) a manual journal entry. */
  async createEntry(input: {
    date: string;
    questionSlug: string;
    answerText: string | null;
    answerNumeric: number | null;
  }): Promise<JournalEntryFullRow> {
    await this.ensureDofekProvider();

    const rows = await executeWithSchema(
      this.#db,
      journalEntryFullRowSchema,
      sql`INSERT INTO fitness.journal_entry (
            user_id, provider_id, date, question_slug, answer_text, answer_numeric
          ) VALUES (
            ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.questionSlug}, ${input.answerText}, ${input.answerNumeric}
          )
          ON CONFLICT (user_id, date, question_slug, provider_id)
          DO UPDATE SET
            answer_text = EXCLUDED.answer_text,
            answer_numeric = EXCLUDED.answer_numeric
          RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error("createEntry: INSERT returned no row");
    return row;
  }

  /** Update a manual journal entry (only own entries via dofek provider). */
  async updateEntry(input: {
    id: string;
    answerText?: string | null;
    answerNumeric?: number | null;
  }): Promise<JournalEntryFullRow | null> {
    const { id, ...fields } = input;
    const setClauses: ReturnType<typeof sql>[] = [];

    if (fields.answerText !== undefined) {
      setClauses.push(
        fields.answerText !== null
          ? sql`answer_text = ${fields.answerText}`
          : sql`answer_text = NULL`,
      );
    }
    if (fields.answerNumeric !== undefined) {
      setClauses.push(
        fields.answerNumeric !== null
          ? sql`answer_numeric = ${fields.answerNumeric}`
          : sql`answer_numeric = NULL`,
      );
    }

    if (setClauses.length === 0) return null;

    const setExpr = sql.join(setClauses, sql`, `);
    const rows = await executeWithSchema(
      this.#db,
      journalEntryFullRowSchema,
      sql`UPDATE fitness.journal_entry
          SET ${setExpr}
          WHERE user_id = ${this.#userId}
            AND provider_id = ${DOFEK_PROVIDER_ID}
            AND id = ${id}
          RETURNING *`,
    );
    return rows[0] ?? null;
  }

  /** Delete a manual journal entry (only own entries via dofek provider). */
  async deleteEntry(id: string): Promise<{ success: boolean }> {
    await this.#db.execute(
      sql`DELETE FROM fitness.journal_entry
          WHERE user_id = ${this.#userId}
            AND provider_id = ${DOFEK_PROVIDER_ID}
            AND id = ${id}`,
    );
    return { success: true };
  }

  /** Create a custom journal question. */
  async createQuestion(input: {
    slug: string;
    displayName: string;
    category: string;
    dataType: string;
    unit: string | null;
  }): Promise<JournalQuestionRow> {
    const rows = await executeWithSchema(
      this.#db,
      journalQuestionRowSchema,
      sql`INSERT INTO fitness.journal_question (slug, display_name, category, data_type, unit)
          VALUES (${input.slug}, ${input.displayName}, ${input.category}, ${input.dataType}, ${input.unit})
          RETURNING slug, display_name, category, data_type, unit, sort_order`,
    );
    const row = rows[0];
    if (!row) throw new Error("createQuestion: INSERT returned no row");
    return row;
  }
}
