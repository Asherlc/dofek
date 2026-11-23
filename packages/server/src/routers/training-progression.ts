import { z } from "zod";
import { trainingProgressionCyclingSchema } from "../contracts/training-progression-cycling.ts";
import { trainingProgressionStrengthSchema } from "../contracts/training-progression-strength.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { CyclingProgressionRepository } from "../repositories/cycling-progression-repository.ts";
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
  cycling: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    expiresAt: "localDayBoundary",
    keyVersion: "training-progression-cycling-v1",
    scopeByAccessWindow: true,
    outputSchema: trainingProgressionCyclingSchema,
  })
    .input(z.object({ activityId: z.string().uuid() }))
    .query(({ ctx, input }) => {
      const activities = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return new CyclingProgressionRepository(
        ctx.db,
        ctx.sensorStore,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        activities,
      ).getCyclingProgression(input.activityId);
    }),
});
