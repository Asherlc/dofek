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
});
