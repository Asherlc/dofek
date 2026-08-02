import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import {
  LifeEventsRepository,
  PersonalExperimentAssociationError,
} from "../repositories/life-events-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const lifeEventsRouter = router({
  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
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
        personalExperimentId: z.guid().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      try {
        const event = await repo.create(input);
        await invalidateUserQueryDomains(ctx.userId, ["lifeEvents"]);
        return event;
      } catch (error) {
        if (error instanceof PersonalExperimentAssociationError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        }
        throw error;
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        label: z.string().min(1).optional(),
        startedAt: z.string().optional(),
        endedAt: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        ongoing: z.boolean().optional(),
        notes: z.string().nullable().optional(),
        personalExperimentId: z.guid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      try {
        const event = await repo.update(id, fields);
        if (event !== null) {
          await invalidateUserQueryDomains(ctx.userId, ["lifeEvents"]);
        }
        return event;
      } catch (error) {
        if (error instanceof PersonalExperimentAssociationError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        }
        throw error;
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
    const result = await repo.delete(input.id);
    await invalidateUserQueryDomains(ctx.userId, ["lifeEvents"]);
    return result;
  }),

  /** Analyze: compare metrics before vs after (or during vs outside) a life event */
  analyze: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(
      z.object({
        id: z.guid(),
        windowDays: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new LifeEventsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.analyze(input.id, input.windowDays);
    }),
});
