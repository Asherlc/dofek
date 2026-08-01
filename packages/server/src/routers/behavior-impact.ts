import type { ProviderProvenance } from "@dofek/providers/providers";
import { z } from "zod";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import {
  type BehaviorAssociation,
  BehaviorImpactRepository,
  behaviorAssociationSchema,
} from "../repositories/behavior-impact-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export interface BehaviorImpact {
  questionSlug: string;
  displayName: string;
  category: string;
  impactPercent: number;
  yesCount: number;
  noCount: number;
  sources: ProviderProvenance[];
  association: BehaviorAssociation;
}

function observationWindow(days: number | null): string {
  return days === null ? "all available history" : `${days} days`;
}

const behaviorImpactOutputSchema = z.array(
  z.object({
    questionSlug: z.string(),
    displayName: z.string(),
    category: z.string(),
    impactPercent: z.number(),
    yesCount: z.number().int().nonnegative(),
    noCount: z.number().int().nonnegative(),
    sources: z.array(z.object({ providerId: z.string(), label: z.string() })),
    association: behaviorAssociationSchema,
  }),
);

export const behaviorImpactRouter = router({
  impactSummary: selectedChartRangeQuery(
    "behaviorImpact.impactSummary",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<BehaviorImpact[]> => {
      const repo = new BehaviorImpactRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      const impacts = await repo.getImpactSummary(range.days);
      const windowLabel = observationWindow(range.days);
      return impacts.map((impact) => {
        const detail = impact.toDetail();
        return {
          ...detail,
          association: { ...detail.association, observationWindow: windowLabel },
        };
      });
    },
    {
      min: 7,
      max: 365,
      keyVersion: "association-semantics-v1",
      outputSchema: behaviorImpactOutputSchema,
    },
  ),
});
