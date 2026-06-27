import {
  createOrGetCompanionToken,
  regenerateCompanionToken,
} from "../companion/token-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const companionTokenRouter = router({
  retrieve: protectedProcedure.query(async ({ ctx }) => {
    return createOrGetCompanionToken(ctx.db, ctx.userId);
  }),

  regenerate: protectedProcedure.mutation(async ({ ctx }) => {
    return regenerateCompanionToken(ctx.db, ctx.userId);
  }),
});
