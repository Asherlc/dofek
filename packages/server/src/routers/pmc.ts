import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
export type { PmcChartResult, PmcDataPoint, TssModelInfo };

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  makeTrainingChartAvailability,
  type TrainingChartAvailability,
  trainingChartAvailabilitySchema,
} from "../contracts/training-chart-availability.ts";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { PmcRepository } from "../repositories/pmc-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

type PmcChartResultWithAvailability = PmcChartResult & {
  availability: TrainingChartAvailability;
};

const pmcChartOutputSchema = z.object({
  data: z.array(
    z.object({
      date: z.string(),
      load: z.number(),
      ctl: z.number(),
      atl: z.number(),
      tsb: z.number(),
    }),
  ),
  model: z.object({
    type: z.enum(["learned", "generic"]),
    pairedActivities: z.number(),
    r2: z.number().nullable(),
    ftp: z.number().nullable(),
  }),
  availability: trainingChartAvailabilitySchema,
}) satisfies z.ZodType<PmcChartResultWithAvailability>;

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Reads activities + Normalized Power from ClickHouse analytics tables.
   * Computes daily TSS using a learned regression model (power+HR paired activities)
   * when available, falling back to generic Bannister TRIMP normalization.
   * Derives CTL (42d), ATL (7d), TSB from daily TSS.
   */
  chart: selectedChartRangeQuery(
    "pmc.chart",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<PmcChartResultWithAvailability> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "pmc.chart");
      const repo = new PmcRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      const result = await repo.getChart(range);
      return {
        ...result,
        availability: makeTrainingChartAvailability({
          sourceLabel: "Training load read model",
          observedCount: result.data.length,
          minimumCount: 1,
          messages: {
            available: "Training load data is available from the training load read model.",
            insufficientData:
              "No training load data is available from the training load read model. Record at least 1 activity with heart-rate or power data to show this chart.",
          },
        }),
      };
    },
    {
      keyVersion: "pmc-chart-availability-v1",
      outputSchema: pmcChartOutputSchema,
    },
  ),
});
