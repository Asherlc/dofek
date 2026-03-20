import { DEFAULT_USER_ID } from "dofek/db/schema";
import { logger } from "../logger.ts";
import { appRouter } from "../router.ts";

/** Fire common queries sequentially to populate cache without overwhelming the DB.
 *  Uses DEFAULT_USER_ID for backwards compatibility — only warms for the primary user. */
export async function warmCache(db: import("dofek/db").Database): Promise<void> {
  const caller = appRouter.createCaller({ db, userId: DEFAULT_USER_ID, timezone: "UTC" });
  const queries: Array<[string, () => Promise<unknown>]> = [
    // Dashboard
    ["dailyMetrics.list(30)", () => caller.dailyMetrics.list({ days: 30 })],
    ["dailyMetrics.list(90)", () => caller.dailyMetrics.list({ days: 90 })],
    ["dailyMetrics.trends(30)", () => caller.dailyMetrics.trends({ days: 30 })],
    ["training.nextWorkout", () => caller.training.nextWorkout()],
    ["dailyMetrics.latest", () => caller.dailyMetrics.latest()],
    ["sleep.list(30)", () => caller.sleep.list({ days: 30 })],
    ["sync.providers", () => caller.sync.providers()],
    ["sync.providerStats", () => caller.sync.providerStats()],
    ["insights.compute(90)", () => caller.insights.compute({ days: 90 })],
    // Training page
    ["training.weeklyVolume(90)", () => caller.training.weeklyVolume({ days: 90 })],
    ["training.hrZones(90)", () => caller.training.hrZones({ days: 90 })],
    ["pmc.chart(90)", () => caller.pmc.chart({ days: 90 })],
    ["power.powerCurve(90)", () => caller.power.powerCurve({ days: 90 })],
    ["power.eftpTrend(90)", () => caller.power.eftpTrend({ days: 90 })],
    // Cycling analytics page — warm all endpoints to avoid cold-cache 502s
    ["efficiency.aerobicEfficiency(180)", () => caller.efficiency.aerobicEfficiency({ days: 180 })],
    ["efficiency.polarizationTrend(180)", () => caller.efficiency.polarizationTrend({ days: 180 })],
    ["cyclingAdvanced.rampRate(90)", () => caller.cyclingAdvanced.rampRate({ days: 90 })],
    [
      "cyclingAdvanced.trainingMonotony(90)",
      () => caller.cyclingAdvanced.trainingMonotony({ days: 90 }),
    ],
    [
      "cyclingAdvanced.activityVariability(90)",
      () => caller.cyclingAdvanced.activityVariability({ days: 90, limit: 20, offset: 0 }),
    ],
    [
      "cyclingAdvanced.verticalAscentRate(90)",
      () => caller.cyclingAdvanced.verticalAscentRate({ days: 90 }),
    ],
    // Running page
    ["running.dynamics(90)", () => caller.running.dynamics({ days: 90 })],
    ["running.paceTrend(90)", () => caller.running.paceTrend({ days: 90 })],
  ];
  let ok = 0;
  for (const [name, fn] of queries) {
    try {
      await fn();
      ok++;
    } catch (err) {
      logger.error(`[cache] Failed to warm ${name}: ${err}`);
    }
  }
  logger.info(`[cache] Warmed ${ok}/${queries.length} queries`);
}
