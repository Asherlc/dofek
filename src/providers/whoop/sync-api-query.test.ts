import { describe, expect, it } from "vitest";
import { whoopSyncStepToApiQuery } from "./sync-api-query.ts";

describe("whoopSyncStepToApiQuery", () => {
  const context = {
    since: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-03T00:00:00.000Z"),
  };

  it("maps heart rate windows to the metrics-service path and filters", () => {
    expect(
      whoopSyncStepToApiQuery(
        {
          type: "heart_rate",
          start: "2026-05-01T00:00:00.000Z",
          end: "2026-05-08T00:00:00.000Z",
        },
        context,
      ),
    ).toEqual({
      path: "metrics-service/v1/metrics",
      filters: {
        name: "heart_rate",
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
        step: 6,
      },
    });
  });

  it("returns null for local-only steps", () => {
    expect(whoopSyncStepToApiQuery({ type: "persist_workouts" }, context)).toBeNull();
  });

  it("maps strain_deep_dive to the deep-dive strain path", () => {
    expect(
      whoopSyncStepToApiQuery({ type: "strain_deep_dive", date: "2026-05-01" }, context),
    ).toEqual({
      path: "home-service/v1/deep-dive/strain",
      filters: { date: "2026-05-01" },
    });
  });

  it("maps sleep_stages to the sleep-events path", () => {
    expect(whoopSyncStepToApiQuery({ type: "sleep_stages", sleepId: "sleep-1" }, context)).toEqual({
      path: "sleep-service/v1/sleep-events",
      filters: { sleepId: "sleep-1" },
    });
  });

  it("maps developer_workouts to the activity workout path with null nextToken when omitted", () => {
    expect(whoopSyncStepToApiQuery({ type: "developer_workouts" }, context)).toEqual({
      path: "developer/v2/activity/workout",
      filters: { nextToken: null },
    });
  });

  it("maps developer_workouts with a nextToken value", () => {
    expect(
      whoopSyncStepToApiQuery({ type: "developer_workouts", nextToken: "abc" }, context),
    ).toEqual({
      path: "developer/v2/activity/workout",
      filters: { nextToken: "abc" },
    });
  });

  it("maps weightlifting to the weightlifting-workout path", () => {
    expect(whoopSyncStepToApiQuery({ type: "weightlifting", activityId: "wl-1" }, context)).toEqual(
      {
        path: "weightlifting-service/v2/weightlifting-workout",
        filters: { activityId: "wl-1" },
      },
    );
  });

  it("maps journal to the behavior impact path with ISO dates from context", () => {
    expect(whoopSyncStepToApiQuery({ type: "journal" }, context)).toEqual({
      path: "behavior-impact-service/v1/impact",
      filters: {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-03T00:00:00.000Z",
      },
    });
  });
});
