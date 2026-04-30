import type { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { fitCriticalHeartRate } from "../repositories/duration-curves-repository.ts";

describe("fitCriticalHeartRate", () => {
  it("returns null with fewer than 3 points", () => {
    expect(
      fitCriticalHeartRate([
        { durationSeconds: 300, bestHeartRate: 180 },
        { durationSeconds: 600, bestHeartRate: 175 },
      ]),
    ).toBeNull();
  });

  it("fits a model from valid HR curve data", () => {
    // Simulated HR curve: HR decreases with longer durations
    // At short durations you can sustain higher HR, longer durations trend toward threshold
    const points = [
      { durationSeconds: 120, bestHeartRate: 190 },
      { durationSeconds: 300, bestHeartRate: 185 },
      { durationSeconds: 600, bestHeartRate: 180 },
      { durationSeconds: 1200, bestHeartRate: 175 },
      { durationSeconds: 1800, bestHeartRate: 172 },
      { durationSeconds: 3600, bestHeartRate: 168 },
    ];

    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // Threshold HR should be in a physiologically reasonable range
    expect(model?.thresholdHr).toBeGreaterThan(150);
    expect(model?.thresholdHr).toBeLessThan(195);
    expect(model?.r2).toBeGreaterThan(0);
  });

  it("treats flat HR as threshold HR with perfect fit", () => {
    // Constant HR across durations — model fits perfectly with thresholdHr = 170
    const points = [
      { durationSeconds: 120, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 170 },
      { durationSeconds: 1200, bestHeartRate: 170 },
    ];

    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    expect(model?.thresholdHr).toBe(170);
    expect(model?.r2).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Router procedure tests (kill delegation mutations in duration-curves.ts)
// ---------------------------------------------------------------------------

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; sensorStore?: unknown; userId: string | null; timezone: string }>()
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
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

const { durationCurvesRouter } = await import("./duration-curves.ts");
const { createTestCallerFactory } = await import("./test-helpers.ts");

const createCaller = createTestCallerFactory(durationCurvesRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  const sensorStore = {
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue(rows),
    getPaceCurveRows: vi.fn().mockResolvedValue(rows),
  };
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    sensorStore,
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("durationCurvesRouter", () => {
  describe("hrCurve", () => {
    it("returns heart rate curve data", async () => {
      const rows = [
        { duration_seconds: 300, best_hr: 185, activity_date: "2026-04-01" },
        { duration_seconds: 600, best_hr: 180, activity_date: "2026-04-02" },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrCurve({ days: 90 });
      expect(result.points).toHaveLength(2);
    });

    it("uses default days (90) when not specified", async () => {
      const caller = makeCaller([]);
      const result = await caller.hrCurve({});
      expect(result.points).toEqual([]);
    });

    it("returns empty points when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.hrCurve({ days: 30 });
      expect(result.points).toEqual([]);
    });
  });

  describe("paceCurve", () => {
    it("returns pace curve data", async () => {
      const rows = [
        { duration_seconds: 300, best_pace: 240, activity_date: "2026-04-01" },
        { duration_seconds: 600, best_pace: 260, activity_date: "2026-04-02" },
      ];
      const caller = makeCaller(rows);
      const result = await caller.paceCurve({ days: 90 });
      expect(result.points).toHaveLength(2);
    });

    it("uses default days (90) when not specified", async () => {
      const caller = makeCaller([]);
      const result = await caller.paceCurve({});
      expect(result.points).toEqual([]);
    });
  });

  it("throws PRECONDITION_FAILED when sensor store is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.hrCurve({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: "PRECONDITION_FAILED",
    });
  });

  it("throws PRECONDITION_FAILED for paceCurve when sensor store is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.paceCurve({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: "PRECONDITION_FAILED",
      message:
        "ClickHouse activity analytics store is required for duration curves. Set CLICKHOUSE_URL and retry.",
    });
  });
});
