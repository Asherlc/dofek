import { describe, expect, it, vi } from "vitest";
import type {
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { climbingRouter } from "./climbing.ts";

const createCaller = createTestCallerFactory(climbingRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  return createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "America/Los_Angeles",
  });
}

describe("climbingRouter", () => {
  it("returns grade progression rows", async () => {
    const caller = makeCaller([
      {
        session_date: "2026-07-09",
        climb_type: "boulder",
        grade_system: "v_scale",
        grade: "V4",
      },
    ]);

    const result: ClimbingGradeProgressionRow[] = await caller.gradeProgression({ days: 90 });

    expect(result).toEqual([
      {
        date: "2026-07-09",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 4,
      },
    ]);
  });

  it("returns volume by grade rows", async () => {
    const caller = makeCaller([
      {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.10c",
        attempts: 3,
        sends: 2,
      },
    ]);

    const result: ClimbingVolumeByGradeRow[] = await caller.volumeByGrade({ days: 90 });

    expect(result).toEqual([
      {
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.10c",
        gradeSortValue: 5103,
        attempts: 3,
        sends: 2,
      },
    ]);
  });

  it("returns session summary rows", async () => {
    const caller = makeCaller([
      {
        activity_id: "activity-1",
        session_date: "2026-07-09",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        location_name: "Touchstone Pacific Pipe",
        attempts: 9,
        sends: 6,
        hardest_boulder_grade: "V4",
        hardest_route_grade: null,
      },
    ]);

    const result: ClimbingSessionSummaryRow[] = await caller.sessionSummary({ days: 90 });

    expect(result).toEqual([
      {
        activityId: "activity-1",
        date: "2026-07-09",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        attempts: 9,
        sends: 6,
        hardestBoulderGrade: "V4",
        hardestBoulderGradeSortValue: 4,
        hardestRouteGrade: null,
        hardestRouteGradeSortValue: null,
      },
    ]);
  });

  it("returns empty arrays when there is no climbing data", async () => {
    const caller = makeCaller([]);

    await expect(caller.gradeProgression({ days: 90 })).resolves.toEqual([]);
    await expect(caller.volumeByGrade({ days: 90 })).resolves.toEqual([]);
    await expect(caller.sessionSummary({ days: 90 })).resolves.toEqual([]);
  });
});
