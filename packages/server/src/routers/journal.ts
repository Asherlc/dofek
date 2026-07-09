import { z } from "zod";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { rangeDaysSchema } from "../lib/date-window.ts";
import { JournalRepository } from "../repositories/journal-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const journalRouter = router({
  /** List all available journal questions ordered by sort_order */
  questions: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM }).query(async ({ ctx }) => {
    const repository = new JournalRepository(ctx.db, ctx.userId);
    return repository.listQuestions();
  }),

  /** Get journal entries for a date range, joined with question metadata */
  entries: selectedChartRangeQuery("journal.entries", CacheTTL.SHORT, async ({ ctx, range }) => {
    const repository = new JournalRepository(ctx.db, ctx.userId);
    return repository.listEntries(range.days);
  }),

  /** Time-series trend data for a specific question */
  trends: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(
      z.object({
        questionSlug: z.string(),
        days: rangeDaysSchema(90),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repository = new JournalRepository(ctx.db, ctx.userId);
      return repository.listTrends(input.questionSlug, input.days);
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
      const repository = new JournalRepository(ctx.db, ctx.userId);
      return repository.createEntry(input);
    }),

  /** Update a manual journal entry (only own entries via dofek provider) */
  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        answerText: z.string().nullable().optional(),
        answerNumeric: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repository = new JournalRepository(ctx.db, ctx.userId);
      return repository.updateEntry(input);
    }),

  /** Delete a manual journal entry (only own entries via dofek provider) */
  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const repository = new JournalRepository(ctx.db, ctx.userId);
    return repository.deleteEntry(input.id);
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
      const repository = new JournalRepository(ctx.db, ctx.userId);
      return repository.createQuestion(input);
    }),
});
