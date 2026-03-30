import { type BreathworkTechnique, TECHNIQUES } from "@dofek/scoring/breathwork";
import { z } from "zod";
import { BreathworkRepository } from "../repositories/breathwork-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const breathworkRouter = router({
  techniques: cachedProtectedQuery(CacheTTL.LONG).query((): BreathworkTechnique[] => TECHNIQUES),
  logSession: protectedProcedure
    .input(
      z.object({
        techniqueId: z.string().min(1),
        rounds: z.number().int().min(1),
        durationSeconds: z.number().int().min(1),
        startedAt: z.string(),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new BreathworkRepository(ctx.db, ctx.userId);
      const session = await repo.logSession(input);
      return session?.toDetail() ?? null;
    }),
  history: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().min(1).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const repo = new BreathworkRepository(ctx.db, ctx.userId);
      return (await repo.getHistory(input.days)).map((session) => session.toDetail());
    }),
});
