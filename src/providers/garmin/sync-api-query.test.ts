import { describe, expect, it } from "vitest";
import { garminSyncStepToApiQuery } from "./sync-api-query.ts";

describe("garminSyncStepToApiQuery", () => {
  it("returns activities_list query given an activities_list step with default offset", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "activities_list",
        offset: 0,
      }),
    ).toEqual({
      path: "connectapi/activities",
      filters: { start: 0 },
    });
  });

  it("propagates offset for paginated activities_list steps", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "activities_list",
        offset: 50,
      }),
    ).toEqual({
      path: "connectapi/activities",
      filters: { start: 50 },
    });
  });

  it("returns activity_detail query given an activity_detail step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "activity_detail",
        activityId: 123,
        activityModality: null,
      }),
    ).toEqual({
      path: "connectapi/activity",
      filters: { activityId: 123, activityModality: null },
    });
  });

  it("returns null for activity_reconcile step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "activity_reconcile",
      }),
    ).toBeNull();
  });

  it("returns sleep query given a sleep step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "sleep",
        date: "2026-01-01",
      }),
    ).toEqual({
      path: "connectapi/sleep",
      filters: { date: "2026-01-01" },
    });
  });

  it("returns daily_summary query given a daily_summary step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "daily_summary",
        date: "2026-01-01",
      }),
    ).toEqual({
      path: "connectapi/daily-summary",
      filters: { date: "2026-01-01" },
    });
  });

  it("returns hrv_summary query given an hrv_summary step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "hrv_summary",
        date: "2026-01-01",
      }),
    ).toEqual({
      path: "connectapi/hrv",
      filters: { date: "2026-01-01" },
    });
  });

  it("returns stress query given a stress step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "stress",
        date: "2026-01-01",
      }),
    ).toEqual({
      path: "connectapi/stress",
      filters: { date: "2026-01-01" },
    });
  });

  it("returns heart_rate query given a heart_rate step", () => {
    expect(
      garminSyncStepToApiQuery({
        type: "heart_rate",
        date: "2026-01-01",
      }),
    ).toEqual({
      path: "connectapi/heart-rate",
      filters: { date: "2026-01-01" },
    });
  });
});
