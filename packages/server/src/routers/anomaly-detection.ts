import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type AnomalyCheckResult,
  AnomalyDetectionRepository,
  type AnomalyRow,
  checkAnomalies,
  sendAnomalyAlertToSlack,
} from "../repositories/anomaly-detection-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

// ── Re-exports (preserve public API) ───────────────────────────────
export type { AnomalyRow, AnomalyCheckResult };
export { checkAnomalies, sendAnomalyAlertToSlack };

// ── Router ───────────────────────────────────────────────────────────

export const anomalyDetectionRouter = router({
  /**
   * Check today's health metrics for anomalies.
   * Returns any metrics that deviate significantly from the 30-day baseline.
   */
  check: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<AnomalyCheckResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "anomalyDetection.check");
      const repo = new AnomalyDetectionRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      return repo.check(input.endDate);
    }),

  /**
   * Historical anomalies: check each day over a period for deviations.
   * Useful for the dashboard to show anomaly markers on time-series charts.
   */
  history: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<AnomalyRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "anomalyDetection.history");
      const repo = new AnomalyDetectionRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      return repo.getHistory(input.days, new Date().toISOString().slice(0, 10));
    }),
});
