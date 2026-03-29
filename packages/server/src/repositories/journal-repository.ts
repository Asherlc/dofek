import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

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

const trendPointSchema = z.object({
  date: dateStringSchema,
  value: z.coerce.number().nullable(),
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
export type JournalEntryRow = z.infer<typeof journalEntryRowSchema>;
export type TrendPoint = z.infer<typeof trendPointSchema>;
export type JournalEntryFullRow = z.infer<typeof journalEntryFullRowSchema>;

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
    await this.#db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App')
          ON CONFLICT (id) DO NOTHING`,
    );
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
  async listEntries(days: number): Promise<JournalEntryRow[]> {
    return executeWithSchema(
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
            AND je.date >= (CURRENT_DATE - ${days}::int)
          ORDER BY je.date DESC, jq.sort_order, jq.display_name`,
    );
  }

  /** Time-series trend data for a specific question. */
  async listTrends(questionSlug: string, days: number): Promise<TrendPoint[]> {
    return executeWithSchema(
      this.#db,
      trendPointSchema,
      sql`SELECT
            je.date,
            je.answer_numeric AS value
          FROM fitness.journal_entry je
          WHERE je.user_id = ${this.#userId}
            AND je.question_slug = ${questionSlug}
            AND je.date >= (CURRENT_DATE - ${days}::int)
            AND je.answer_numeric IS NOT NULL
          ORDER BY je.date`,
    );
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
