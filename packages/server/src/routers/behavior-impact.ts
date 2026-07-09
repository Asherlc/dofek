import { z } from "zod";
import { selectedChartRangeDaysSchema } from "../lib/date-window.ts";
import { BehaviorImpactRepository } from "../repositories/behavior-impact-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface BehaviorImpact {
  questionSlug: string;
  displayName: string;
  category: string;
  impactPercent: number;
  yesCount: number;
  noCount: number;
}

export const behaviorImpactRouter = router({
  impactSummary: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        days: selectedChartRangeDaysSchema("behaviorImpact.impactSummary", { min: 7, max: 365 }),
      }),
    )
    .query(async ({ ctx, input }): Promise<BehaviorImpact[]> => {
      const repo = new BehaviorImpactRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      const impacts = await repo.getImpactSummary(input.days);
      return impacts.map((impact) => impact.toDetail());
    }),
});
