import { trainingProgressionStrengthSchema } from "../contracts/training-progression-strength.ts";
import { StrengthProgressionRepository } from "../repositories/strength-progression-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const trainingProgressionRouter = router({
  strength: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    expiresAt: "localDayBoundary",
    keyVersion: "training-progression-strength-v1",
    scopeByAccessWindow: true,
    outputSchema: trainingProgressionStrengthSchema,
  }).query(({ ctx }) =>
    new StrengthProgressionRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
    ).getStrengthProgression(),
  ),
});
