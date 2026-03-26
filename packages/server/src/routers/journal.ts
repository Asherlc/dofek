import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const DOFEK_PROVIDER_ID = "dofek";

/** Ensure the 'dofek' provider row exists (for manual entries) */
async function ensureDofekProvider(
  db: Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"],
) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App')
        ON CONFLICT (id) DO NOTHING`,
  );
}

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

export const journalRouter = router({
  /** List all available journal questions ordered by sort_order */
  questions: cachedProtectedQuery(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    return executeWithSchema(
      ctx.db,
      journalQuestionRowSchema,
      sql`SELECT slug, display_name, category, data_type, unit, sort_order
          FROM fitness.journal_question
          ORDER BY sort_order, display_name`,
    );
  }),

  /** Get journal entries for a date range, joined with question metadata */
  entries: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
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
            WHERE je.user_id = ${ctx.userId}
              AND je.date >= (CURRENT_DATE - ${input.days}::int)
            ORDER BY je.date DESC, jq.sort_order, jq.display_name`,
      );
    }),

  /** Time-series trend data for a specific question */
  trends: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        questionSlug: z.string(),
        days: z.number().default(90),
      }),
    )
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        trendPointSchema,
        sql`SELECT
              je.date,
              je.answer_numeric AS value
            FROM fitness.journal_entry je
            WHERE je.user_id = ${ctx.userId}
              AND je.question_slug = ${input.questionSlug}
              AND je.date >= (CURRENT_DATE - ${input.days}::int)
              AND je.answer_numeric IS NOT NULL
            ORDER BY je.date`,
      );
    }),

  /** Create a manual journal entry */
  create: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        questionSlug: z.string().min(1),
        answerText: z.string().nullable().default(null),
        answerNumeric: z.number().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureDofekProvider(ctx.db);

      const rows = await executeWithSchema(
        ctx.db,
        journalEntryFullRowSchema,
        sql`INSERT INTO fitness.journal_entry (
              user_id, provider_id, date, question_slug, answer_text, answer_numeric
            ) VALUES (
              ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
              ${input.questionSlug}, ${input.answerText}, ${input.answerNumeric}
            )
            ON CONFLICT (user_id, date, question_slug, provider_id)
            DO UPDATE SET
              answer_text = EXCLUDED.answer_text,
              answer_numeric = EXCLUDED.answer_numeric
            RETURNING *`,
      );
      return rows[0];
    }),

  /** Update a manual journal entry (only own entries via dofek provider) */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        answerText: z.string().nullable().optional(),
        answerNumeric: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
        ctx.db,
        journalEntryFullRowSchema,
        sql`UPDATE fitness.journal_entry
            SET ${setExpr}
            WHERE user_id = ${ctx.userId}
              AND provider_id = ${DOFEK_PROVIDER_ID}
              AND id = ${id}
            RETURNING *`,
      );
      return rows[0] ?? null;
    }),

  /** Delete a manual journal entry (only own entries via dofek provider) */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`DELETE FROM fitness.journal_entry
            WHERE user_id = ${ctx.userId}
              AND provider_id = ${DOFEK_PROVIDER_ID}
              AND id = ${input.id}`,
      );
      return { success: true };
    }),

  /** Create a custom journal question */
  createQuestion: protectedProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z][a-z0-9_]*$/, "Slug must be lowercase alphanumeric with underscores"),
        displayName: z.string().min(1),
        category: z.enum(["substance", "activity", "wellness", "nutrition", "custom"]),
        dataType: z.enum(["boolean", "numeric", "text"]),
        unit: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        journalQuestionRowSchema,
        sql`INSERT INTO fitness.journal_question (slug, display_name, category, data_type, unit)
            VALUES (${input.slug}, ${input.displayName}, ${input.category}, ${input.dataType}, ${input.unit})
            RETURNING slug, display_name, category, data_type, unit, sort_order`,
      );
      return rows[0];
    }),
});
