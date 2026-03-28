import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import {
  type AnomalyCheckResult,
  AnomalyDetectionRepository,
  type AnomalyRow,
  checkAnomalies,
  sendAnomalyAlertToSlack,
} from "../repositories/anomaly-detection-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ── Re-exports (preserve public API) ───────────────────────────────
export type { AnomalyRow, AnomalyCheckResult };
export { checkAnomalies, sendAnomalyAlertToSlack };

// ── Router ───────────────────────────────────────────────────────────

export const anomalyDetectionRouter = router({
  /**
   * Check today's health metrics for anomalies.
   * Returns any metrics that deviate significantly from the 30-day baseline.
   */
  check: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<AnomalyCheckResult> => {
      const repo = new AnomalyDetectionRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.check(input.endDate);
    }),

  /**
   * Historical anomalies: check each day over a period for deviations.
   * Useful for the dashboard to show anomaly markers on time-series charts.
   */
  history: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<AnomalyRow[]> => {
      const repo = new AnomalyDetectionRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getHistory(input.days, "today");
    }),
});
