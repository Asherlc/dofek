import { supplementDoseOccurrencesSchema } from "@dofek/format/supplement-dose-events";
import { z } from "zod";
import {
  SupplementsRepository,
  supplementListSchema,
} from "../repositories/supplements-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const supplementsRouter = router({
  list: protectedProcedure.output(supplementListSchema).query(async ({ ctx }) => {
    const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repository.list();
  }),
  occurrences: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(7) }))
    .output(supplementDoseOccurrencesSchema)
    .query(async ({ ctx, input }) => {
      const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.occurrences(input.days);
    }),
});
