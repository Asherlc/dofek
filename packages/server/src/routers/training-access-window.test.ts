import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted(() => vi.fn());

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: (options: unknown) => {
      cachedQueryOptions(options);
      return trpc.procedure;
    },
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

import { trainingRouter } from "./training.ts";

const createCaller = createTestCallerFactory(trainingRouter);

describe("trainingRouter access window gating", () => {
  it("versions the activity state cache contract", () => {
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 3_600_000,
      keyVersion: "training-activity-states-v1",
    });
  });

  it("weeklyVolume throws a specific precondition error when the sensor store is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.weeklyVolume({ days: 90 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "training requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
    });
  });

  it("weeklyVolume passes accessWindow to repository (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([{ activity_count: 1 }]);
    const sensorStore = makeMockSensorStore([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
    const result = await caller.weeklyVolume({ days: 90 });
    expect(result).toEqual([]);
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("started_at >= toDateTime({accessStart:String})"),
      expect.objectContaining({
        accessStart: "2026-04-10",
        accessEnd: "2026-04-17",
      }),
    );
  });

  it("hrZones returns the canonical empty server distribution", async () => {
    const execute = vi.fn().mockResolvedValue([{ activity_count: 0 }]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeMockSensorStore(),
    });

    const result = await caller.hrZones({ days: 90 });

    expect(result).toMatchObject({
      maxHr: null,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 0,
      },
    });
    expect(result.intensityDistribution.zones).toHaveLength(6);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("activityStats returns per-activity rows from the analytics store", async () => {
    const sensorStore = makeMockSensorStore([
      [
        {
          id: "activity-1",
          canonical_type: "running",
          name: "Morning Run",
          started_at: "2026-05-19T14:00:00.000Z",
          ended_at: "2026-05-19T15:00:00.000Z",
          avg_hr: 145.5,
          max_hr: 172,
          avg_power: null,
          max_power: null,
          avg_cadence: 82,
          hr_samples: 3600,
          power_samples: 0,
          distance_meters: 10500,
        },
      ],
    ]);
    const caller = createCaller({
      db: (() => {
        const execute = vi.fn();
        execute.mockResolvedValueOnce([{ activity_count: 1 }]);
        execute.mockResolvedValueOnce([{ id: "activity-1" }]);
        execute.mockResolvedValue([]);
        return { execute };
      })(),
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    await expect(caller.activityStats({ days: 30 })).resolves.toEqual([
      {
        id: "activity-1",
        canonical_type: "running",
        name: "Morning Run",
        started_at: "2026-05-19T14:00:00.000Z",
        ended_at: "2026-05-19T15:00:00.000Z",
        avg_hr: 145.5,
        max_hr: 172,
        avg_power: null,
        max_power: null,
        avg_cadence: 82,
        hr_samples: 3600,
        power_samples: 0,
        distance_meters: 10500,
        distance_state: { status: "available" },
      },
    ]);
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_summary a"),
      { userId: "user-1", days: 30 },
    );
  });
});
