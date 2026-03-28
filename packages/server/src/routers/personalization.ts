import { PersonalizationRepository } from "../repositories/personalization-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const personalizationRouter = router({
  /** Current personalization status: learned params, effective params, and quality indicators */
  status: cachedProtectedQuery(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    const repo = new PersonalizationRepository(ctx.db, ctx.userId);
    return repo.getStatus();
  }),

  /** Trigger an immediate refit of personalized parameters */
  refit: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = new PersonalizationRepository(ctx.db, ctx.userId);
    return repo.refit();
  }),

  /** Reset to defaults by deleting personalized params */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = new PersonalizationRepository(ctx.db, ctx.userId);
    return repo.reset();
  }),
});
