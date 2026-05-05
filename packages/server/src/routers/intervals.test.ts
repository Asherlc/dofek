import { describe, expect, it, vi } from "vitest";
import { average, maxVal, summarizeSegment } from "../repositories/intervals-repository.ts";

describe("average", () => {
  it("computes average of positive values", () => {
    expect(average([100, 200, 300])).toBe(200);
  });

  it("returns null for empty array", () => {
    expect(average([])).toBeNull();
  });

  it("returns null for all-null array", () => {
    expect(average([null, null])).toBeNull();
  });

  it("ignores null values", () => {
    expect(average([100, null, 200])).toBe(150);
  });

  it("ignores zero values", () => {
    expect(average([0, 100, 200])).toBe(150);
  });

  it("rounds to 1 decimal place", () => {
    expect(average([100, 200, 201])).toBe(167);
  });

  it("returns single value when only one valid", () => {
    expect(average([null, 150, null])).toBe(150);
  });
});

describe("maxVal", () => {
  it("returns max of positive values", () => {
    expect(maxVal([100, 200, 300])).toBe(300);
  });

  it("returns null for empty array", () => {
    expect(maxVal([])).toBeNull();
  });

  it("returns null for all-null array", () => {
    expect(maxVal([null, null])).toBeNull();
  });

  it("ignores null values", () => {
    expect(maxVal([null, 200, null, 100])).toBe(200);
  });

  it("handles single value", () => {
    expect(maxVal([42])).toBe(42);
  });

  it("handles negative values", () => {
    expect(maxVal([-5, -10, -1])).toBe(-1);
  });
});

describe("summarizeSegment", () => {
  type SegmentRow = Parameters<typeof summarizeSegment>[0][number];

  const makeRows = (overrides: Partial<SegmentRow> = {}): SegmentRow[] => [
    {
      avg_power: 200,
      avg_hr: 140,
      avg_speed: 8.5,
      avg_cadence: 85,
      max_power: 250,
      max_hr: 155,
      max_speed: 10.0,
      ...overrides,
    },
    {
      avg_power: 210,
      avg_hr: 145,
      avg_speed: 8.7,
      avg_cadence: 88,
      max_power: 260,
      max_hr: 160,
      max_speed: 10.5,
      ...overrides,
    },
  ];

  it("computes avg and max metrics from segment rows", () => {
    const result = summarizeSegment(
      makeRows(),
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );

    expect(result.startedAt).toBe("2026-03-01T10:00:00");
    expect(result.endedAt).toBe("2026-03-01T10:01:00");
    expect(result.avgPower).toBe(205);
    expect(result.avgHeartRate).toBe(142.5);
    expect(result.avgSpeed).toBe(8.6);
    expect(result.avgCadence).toBe(86.5);
    expect(result.maxPower).toBe(260);
    expect(result.maxHeartRate).toBe(160);
    expect(result.maxSpeed).toBe(10.5);
  });

  it("returns null for metrics when all values are null", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: null,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: null,
        max_speed: null,
      },
    ];
    const result = summarizeSegment(
      rows,
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );

    expect(result.avgPower).toBeNull();
    expect(result.avgHeartRate).toBeNull();
    expect(result.avgSpeed).toBeNull();
    expect(result.avgCadence).toBeNull();
    expect(result.maxPower).toBeNull();
    expect(result.maxHeartRate).toBeNull();
    expect(result.maxSpeed).toBeNull();
  });

  it("rounds maxHeartRate to integer", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: null,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: 155.7,
        max_speed: null,
      },
    ];
    const result = summarizeSegment(
      rows,
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );
    expect(result.maxHeartRate).toBe(156);
  });

  it("converts minute_start to string via String()", () => {
    const result = summarizeSegment(
      makeRows(),
      { minute_start: "2026-03-01T10:00:00+00:00" },
      { minute_start: "2026-03-01T10:05:00+00:00" },
    );
    expect(result.startedAt).toBe("2026-03-01T10:00:00+00:00");
    expect(result.endedAt).toBe("2026-03-01T10:05:00+00:00");
  });
});

// ---------------------------------------------------------------------------
// Router procedure tests (kill delegation mutations in intervals.ts)
// ---------------------------------------------------------------------------

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(rows: unknown[] = []): SensorStore {
  return {
    query: vi.fn().mockResolvedValue(rows),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

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

const { intervalsRouter } = await import("./intervals.ts");
const { createTestCallerFactory } = await import("./test-helpers.ts");

const createCaller = createTestCallerFactory(intervalsRouter);

describe("intervalsRouter", () => {
  describe("byActivity", () => {
    it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await expect(
        caller.byActivity({
          activityId: "00000000-0000-0000-0000-000000000001",
        }),
      ).rejects.toThrow("intervals.byActivity requires the ClickHouse activity analytics store");
    });

    it("returns intervals for an activity", async () => {
      const intervalRows = [
        {
          id: "i-1",
          interval_index: 1,
          label: null,
          interval_type: null,
          started_at: "2026-03-01T10:00:00Z",
          ended_at: "2026-03-01T10:05:00Z",
          duration_seconds: 300,
        },
        {
          id: "i-2",
          interval_index: 2,
          label: null,
          interval_type: null,
          started_at: "2026-03-01T10:05:00Z",
          ended_at: "2026-03-01T10:10:00Z",
          duration_seconds: 300,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(intervalRows) },
        userId: "user-1",
        sensorStore: makeSensorStore([]),
      });
      const result = await caller.byActivity({
        activityId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no intervals", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore: makeSensorStore([]),
      });
      const result = await caller.byActivity({
        activityId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual([]);
    });

    it("rejects invalid UUID", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore: makeSensorStore([]),
      });
      await expect(caller.byActivity({ activityId: "not-a-uuid" })).rejects.toThrow();
    });
  });

  describe("detect", () => {
    it("returns detected intervals", async () => {
      const rows = [{ minute_start: "2026-03-01T10:00:00", avg_power: 200, avg_hr: 140 }];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.detect({
        activityId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeDefined();
    });

    it("rejects invalid UUID", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        sensorStore: makeSensorStore([]),
      });
      await expect(caller.detect({ activityId: "not-a-uuid" })).rejects.toThrow();
    });
  });
});
