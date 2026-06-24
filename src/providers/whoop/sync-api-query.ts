import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import type { WhoopSyncStep } from "./sync-checkpoint.ts";
import type { WhoopPersistenceContext } from "./sync-types.ts";

const WHOOP_HEART_RATE_METRIC_STEP = 6;

export function whoopSyncStepToApiQuery(
  step: WhoopSyncStep,
  context: Pick<WhoopPersistenceContext, "since" | "windowEnd">,
): SyncApiQuery | null {
  switch (step.type) {
    case "strain_deep_dive":
      return {
        path: "home-service/v1/deep-dive/strain",
        filters: { date: step.date },
      };
    case "sleep_stages":
      return {
        path: "sleep-service/v1/sleep-events",
        filters: { sleepId: step.sleepId },
      };
    case "developer_workouts":
      return {
        path: "developer/v2/activity/workout",
        filters: { nextToken: step.nextToken ?? null },
      };
    case "persist_workouts":
      return null;
    case "weightlifting":
      return {
        path: "weightlifting-service/v2/weightlifting-workout",
        filters: { activityId: step.activityId },
      };
    case "heart_rate":
      return {
        path: "metrics-service/v1/metrics",
        filters: {
          name: "heart_rate",
          start: step.start,
          end: step.end,
          step: WHOOP_HEART_RATE_METRIC_STEP,
        },
      };
    case "journal":
      return {
        path: "behavior-impact-service/v1/impact",
        filters: {
          start: context.since.toISOString(),
          end: context.windowEnd.toISOString(),
        },
      };
  }
}
