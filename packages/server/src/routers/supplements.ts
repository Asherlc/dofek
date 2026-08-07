import { supplementDoseOccurrencesSchema } from "@dofek/format/supplement-dose-events";
import { TRPCError } from "@trpc/server";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { invalidateNutritionCaches } from "../lib/nutrition-cache.ts";
import {
  SupplementDoseConflictError,
  SupplementsRepository,
  supplementListSchema,
} from "../repositories/supplements-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const supplementSaveResultSchema = z.object({
  success: z.boolean(),
  count: z.number().int().nonnegative(),
});
const recordedSupplementDoseSchema = z.object({
  id: z.string().uuid(),
  scheduledDate: z.string().date(),
  status: z.enum(["taken", "skipped"]),
});

export const supplementsRouter = router({
  // Installed clients depend on these exact V1 projections. Dose-event
  // procedures are additive; definition identity remains an internal concern.
  list: protectedProcedure.output(supplementListSchema).query(async ({ ctx }) => {
    const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repository.list();
  }),

  save: protectedProcedure
    .input(z.object({ supplements: supplementListSchema }))
    .output(supplementSaveResultSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
      const result = await repository.save(input.supplements);
      await invalidateNutritionCaches(ctx.userId);
      return result;
    }),

  occurrences: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(7) }))
    .output(supplementDoseOccurrencesSchema)
    .query(async ({ ctx, input }) => {
      const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.occurrences(input.days);
    }),

  recordDose: protectedProcedure
    .input(
      z.object({
        expectedCurrentEventId: z.string().uuid(),
        status: z.enum(["taken", "skipped"]),
      }),
    )
    .output(recordedSupplementDoseSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
      try {
        const recorded = await repository.recordDose(input.expectedCurrentEventId, input.status);
        await invalidateNutritionCaches(ctx.userId);
        return recorded;
      } catch (error: unknown) {
        if (error instanceof SupplementDoseConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: error.message,
            cause: error,
          });
        }
        captureException(error, {
          tags: { operation: "supplements.recordDose" },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not record the supplement dose. Reload and try again.",
          cause: error,
        });
      }
    }),
});
