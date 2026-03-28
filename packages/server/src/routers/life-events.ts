import { z } from "zod";
import { LifeEventsRepository } from "../repositories/life-events-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const lifeEventsRouter = router({
  list: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repo.list();
  }),

  create: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1),
        startedAt: z.string(), // YYYY-MM-DD
        endedAt: z.string().nullable().default(null),
        category: z.string().nullable().default(null),
        ongoing: z.boolean().default(false),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.create(input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1).optional(),
        startedAt: z.string().optional(),
        endedAt: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        ongoing: z.boolean().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.update(id, fields);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.delete(input.id);
    }),

  /** Analyze: compare metrics before vs after (or during vs outside) a life event */
  analyze: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        id: z.string().uuid(),
        windowDays: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.analyze(input.id, input.windowDays);
    }),
});
