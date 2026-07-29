import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import type { GarminSyncStep } from "./sync-checkpoint.ts";

export function garminSyncStepToApiQuery(step: GarminSyncStep): SyncApiQuery | null {
  switch (step.type) {
    case "activities_list":
      return { path: "connectapi/activities", filters: { start: step.offset } };
    case "activity_detail":
      return {
        path: "connectapi/activity",
        filters: {
          activityId: step.activityId,
          activityModality: step.activityModality,
        },
      };
    case "activity_reconcile":
      return null;
    case "sleep":
      return { path: "connectapi/sleep", filters: { date: step.date } };
    case "daily_summary":
      return { path: "connectapi/daily-summary", filters: { date: step.date } };
    case "hrv_summary":
      return { path: "connectapi/hrv", filters: { date: step.date } };
    case "stress":
      return { path: "connectapi/stress", filters: { date: step.date } };
    case "heart_rate":
      return { path: "connectapi/heart-rate", filters: { date: step.date } };
  }
}
