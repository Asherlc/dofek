import { invalidateAllQueries, invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { selectedChartDateRangeQuery, selectedChartRangeQuery } from "../lib/chart-range.ts";
import { JournalRepository } from "../repositories/journal-repository.ts";
import {
  buildJournalTrendEvidence,
  journalTrendEvidenceSchema,
} from "../services/journal-trend-evidence.ts";
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

  /** Server-authored evidence for all chartable journal trends in the selected window. */
  trends: selectedChartDateRangeQuery(
    "journal.trends",
    CacheTTL.SHORT,
    async ({ ctx, input, range }) => {
      const repository = new JournalRepository(ctx.db, ctx.userId);
      const entries = await repository.listTrendEntries(range.days, input.endDate);
      return buildJournalTrendEvidence({
        days: range.days,
        endDate: input.endDate,
        entries,
      });
    },
    { outputSchema: journalTrendEvidenceSchema },
  ),

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
      const entry = await repository.createEntry(input);
      await invalidateUserQueryDomains(ctx.userId, ["journalEntries"]);
      return entry;
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
      const entry = await repository.updateEntry(input);
      if (entry !== null) {
        await invalidateUserQueryDomains(ctx.userId, ["journalEntries"]);
      }
      return entry;
    }),

  /** Delete a manual journal entry (only own entries via dofek provider) */
  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const repository = new JournalRepository(ctx.db, ctx.userId);
    const result = await repository.deleteEntry(input.id);
    await invalidateUserQueryDomains(ctx.userId, ["journalEntries"]);
    return result;
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
      const question = await repository.createQuestion(input);
      await invalidateAllQueries();
      return question;
    }),
});
