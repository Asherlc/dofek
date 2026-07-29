import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { BehaviorImpactRepository } from "../repositories/behavior-impact-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export interface BehaviorImpact {
  questionSlug: string;
  displayName: string;
  category: string;
  impactPercent: number;
  yesCount: number;
  noCount: number;
}

export const behaviorImpactRouter = router({
  impactSummary: selectedChartRangeQuery(
    "behaviorImpact.impactSummary",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<BehaviorImpact[]> => {
      const repo = new BehaviorImpactRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      const impacts = await repo.getImpactSummary(range.days);
      return impacts.map((impact) => impact.toDetail());
    },
    { min: 7, max: 365 },
  ),
});
