import { z } from "zod";
import { SupplementsRepository, supplementSchema } from "../repositories/supplements-repository.ts";

import { protectedProcedure, router } from "../trpc.ts";

export const supplementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const repo = new SupplementsRepository(ctx.db, ctx.userId);
    return repo.list();
  }),

  save: protectedProcedure
    .input(z.object({ supplements: z.array(supplementSchema) }))
    .mutation(async ({ ctx, input }) => {
      const repo = new SupplementsRepository(ctx.db, ctx.userId);
      return repo.save(input.supplements);
    }),
});
