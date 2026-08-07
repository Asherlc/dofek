import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { computePolarizationIndex } from "@dofek/zones/zones";
import { captureException as reportException } from "dofek/lib/error-reporting";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { EfficiencyRepository } from "./efficiency-repository.ts";

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(() => "event-id"),
}));

function getRowMaxHeartRate(row: unknown): unknown {
  if (row !== null && typeof row === "object" && "max_hr" in row) {
    return row.max_hr;
  }
  return null;
}

function makeSensorStore(rows: unknown[]): ActivitySensorStore {
  const query = vi
    .fn()
    .mockImplementation(
      async (schema: { parse: (row: unknown) => unknown }, queryText?: string) => {
        // Aerobic-efficiency tests still exercise its live fallback.
        if (queryText?.includes("activity_aerobic_efficiency")) {
          return [];
        }
        if (queryText?.includes("activity_polarization_zones")) {
          return rows.map((row) => schema.parse(row));
        }
        if (queryText?.includes("toInt32(count()) AS endurance_activities")) {
          return [
            schema.parse({
              max_hr: getRowMaxHeartRate(rows[0]),
              endurance_activities: rows.length,
            }),
          ];
        }
        return rows.map((row) => schema.parse(row));
      },
    );
  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ActivitySensorStore;
}

const diagnosticsBySensorStore = new WeakMap<ActivitySensorStore, Record<string, unknown>[]>();

function makeSequentialSensorStore(rowsByCall: Record<string, unknown>[][]): ActivitySensorStore {
  const rowQueue = rowsByCall.map((rows) => [...rows]);
  const diagnosticRows = rowQueue.shift() ?? [];
  const query = vi
    .fn()
    .mockImplementation(
      async (schema: { parse: (row: unknown) => unknown }, queryText?: string) => {
        // Read model queries return empty → exercises fallback path
        if (
          queryText?.includes("activity_aerobic_efficiency") ||
          queryText?.includes("activity_polarization_zones")
        ) {
          return [];
        }
        const rows = rowQueue.shift();
        if (rows == null) {
          throw new Error("No mock sensor-store rows remain for this query");
        }
        return rows.map((row) => schema.parse(row));
      },
    );
  const sensorStore = {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ActivitySensorStore;
  diagnosticsBySensorStore.set(sensorStore, diagnosticRows);
  return sensorStore;
}

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue([
    {
      max_hr: getRowMaxHeartRate(rows[0]),
      endurance_activities: rows.length,
    },
  ]);
  const sensorStore = makeSensorStore(rows);
  const repo = new EfficiencyRepository({ execute }, "user-1", "UTC", sensorStore);
  return { repo, execute, sensorStore };
}

function makeRepositoryWithSensorStore(sensorStore: ActivitySensorStore) {
  const execute = vi.fn().mockResolvedValue(diagnosticsBySensorStore.get(sensorStore) ?? []);
  const repo = new EfficiencyRepository({ execute }, "user-1", "UTC", sensorStore);
  return { repo, execute, sensorStore };
}

function expectCyclingOnlyActivityTypes(activityTypes: unknown) {
  expect(activityTypes).toEqual([...CYCLING_ACTIVITY_TYPES]);
  expect(activityTypes).not.toContain("walking");
  expect(activityTypes).not.toContain("running");
  expect(activityTypes).not.toContain("hiking");
}

const postgresDialect = new PgDialect();

function compiledSql(query: unknown): string {
  return postgresDialect.sqlToQuery(query).sql;
}

// ---------------------------------------------------------------------------
// getAerobicEfficiency
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency", () => {
  it("returns null maxHr and empty activities when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(result).toEqual({ maxHr: null, activities: [] });
  });

  it("returns before the main aggregation when no endurance activities exist", async () => {
    const sensorStore = makeSequentialSensorStore([
      [
        {
          max_hr: null,
          endurance_activities: "0",
        },
      ],
    ]);
    const { repo } = makeRepositoryWithSensorStore(sensorStore);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(sensorStore.query).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("continues to the main aggregation when endurance activities exist", async () => {
    const { repo, sensorStore } = makeRepository([{ max_hr: 190 }]);
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([]) // read model returns empty → fallback
      .mockResolvedValueOnce([
        {
          max_hr: 190,
          date: "2025-06-01",
          canonical_type: "cycling",
          name: "Morning Ride",
          avg_power_z2: 180,
          avg_hr_z2: 135,
          efficiency_factor: 1.333,
          z2_samples: 1800,
        },
      ]);

    await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sensorStore.query).mock.calls[1]?.[1]).toContain(
      "FROM analytics.activity_summary",
    );
    expect(vi.mocked(sensorStore.query).mock.calls[1]?.[1]).toContain("analytics.v_activity");
    expectCyclingOnlyActivityTypes(vi.mocked(sensorStore.query).mock.calls[1]?.[2]?.activityTypes);
  });

  it("matches Zone 2 heart rate samples to power without requiring identical timestamps", async () => {
    const { repo, sensorStore } = makeRepository([{ max_hr: 190 }]);
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          max_hr: 190,
          date: "2025-06-01",
          canonical_type: "cycling",
          name: "Morning Ride",
          avg_power_z2: 180,
          avg_hr_z2: 135,
          efficiency_factor: 1.333,
          z2_samples: 1800,
        },
      ]);

    await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    const fallbackQuery = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    expect(fallbackQuery).toContain("ASOF JOIN");
    expect(fallbackQuery).toContain("power.recorded_at >= am.started_at");
    expect(fallbackQuery).toContain(`ON hr.user_id = pwr.user_id
       AND hr.id = pwr.id
       AND hr.recorded_at >= pwr.recorded_at`);
    expect(fallbackQuery).toContain("AND power.scalar > 0");
    expect(fallbackQuery).not.toContain("WHERE pwr.scalar > 0");
    expect(fallbackQuery).toContain("power.recorded_at > now() - INTERVAL {days:Int32} DAY");
    expect(fallbackQuery).not.toContain("pwr.recorded_at = hr.recorded_at");
  });

  it("keeps lower-bound filters for finite day ranges", async () => {
    const { repo, execute, sensorStore } = makeRepository([]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    const readModelQuery = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const activityDiagnosticQuery = compiledSql(execute.mock.calls[0]?.[0]);
    expect(readModelQuery).toContain("started_at > now() - INTERVAL {days:Int32} DAY");
    expect(activityDiagnosticQuery).toContain("started_at > CURRENT_TIMESTAMP - $");
    expect(activityDiagnosticQuery).toContain("::int * INTERVAL '1 day'");

    warnSpy.mockRestore();
  });

  it("omits all lower-bound filters when days is null", async () => {
    const sensorStore = makeSequentialSensorStore([
      [
        {
          max_hr: "192",
          endurance_activities: "1",
        },
      ],
      [],
      [
        {
          activities_with_power: "0",
          activities_with_hr: "0",
        },
      ],
    ]);
    const { repo, execute } = makeRepositoryWithSensorStore(sensorStore);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await repo.getAerobicEfficiency(ChartRange.fromDays(null));

    const readModelCall = vi.mocked(sensorStore.query).mock.calls[0];
    const fallbackCall = vi.mocked(sensorStore.query).mock.calls[1];
    const sampleDiagnosticCall = vi.mocked(sensorStore.query).mock.calls[2];
    const activityDiagnosticQuery = compiledSql(execute.mock.calls[0]?.[0]);
    expect(readModelCall?.[1]).not.toContain("started_at > now() - INTERVAL");
    expect(fallbackCall?.[1]).not.toContain("asum.started_at > now() - INTERVAL");
    expect(fallbackCall?.[1]).not.toContain("recorded_at > now() - INTERVAL");
    expect(fallbackCall?.[1]).not.toContain("toDate({rhrWindowStart:String})");
    expect(sampleDiagnosticCall?.[1]).not.toContain("asum.started_at > now() - INTERVAL");
    expect(activityDiagnosticQuery).not.toContain("CURRENT_TIMESTAMP");
    expect(readModelCall?.[2]).not.toHaveProperty("days");
    expect(fallbackCall?.[2]).not.toHaveProperty("days");
    expect(fallbackCall?.[2]).not.toHaveProperty("rhrWindowStart");
    expect(sampleDiagnosticCall?.[2]).not.toHaveProperty("days");

    warnSpy.mockRestore();
  });

  it("does not run diagnostics when the main aggregation returns rows", async () => {
    const sensorStore = makeSequentialSensorStore([
      [
        {
          max_hr: "190",
          endurance_activities: "1",
        },
      ],
      [
        {
          max_hr: "190",
          date: "2025-06-01",
          canonical_type: "cycling",
          name: "Morning Ride",
          avg_power_z2: "180.5",
          avg_hr_z2: "135.2",
          efficiency_factor: "1.335",
          z2_samples: "1800",
        },
      ],
    ]);
    const { repo } = makeRepositoryWithSensorStore(sensorStore);

    await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
  });

  it("uses diagnostic max heart rate and logs context when no activities qualify", async () => {
    const sensorStore = makeSequentialSensorStore([
      [
        {
          max_hr: "192",
          endurance_activities: "3",
        },
      ],
      [],
      [
        {
          activities_with_power: "2",
          activities_with_hr: "1",
        },
      ],
    ]);
    const { repo } = makeRepositoryWithSensorStore(sensorStore);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(result).toEqual({ maxHr: 192, activities: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      "[aerobicEfficiency] Empty result for user=user-1 days=90: max_hr=192, endurance_activities=3, with_power=2, with_hr=1",
    );
    expect(sensorStore.query).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sensorStore.query).mock.calls[2]?.[1]).toContain("analytics.v_activity");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        userId: "user-1",
        days: 90,
      }),
    );
    expectCyclingOnlyActivityTypes(vi.mocked(sensorStore.query).mock.calls[2]?.[2]?.activityTypes);

    warnSpy.mockRestore();
  });

  it("does not scan deduped sensor diagnostics when no endurance activities exist", async () => {
    const sensorStore = makeSequentialSensorStore([
      [
        {
          max_hr: null,
          endurance_activities: "0",
        },
      ],
    ]);
    const { repo } = makeRepositoryWithSensorStore(sensorStore);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(result).toEqual({ maxHr: null, activities: [] });
    expect(sensorStore.query).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[aerobicEfficiency] Empty result for user=user-1 days=90: max_hr=null, endurance_activities=0, with_power=0, with_hr=0",
    );

    warnSpy.mockRestore();
  });

  it("does not log an empty diagnostic row", async () => {
    const sensorStore = makeSequentialSensorStore([[], []]);
    const { repo } = makeRepositoryWithSensorStore(sensorStore);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const mockReportException = vi.mocked(reportException);
    mockReportException.mockClear();

    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(result).toEqual({ maxHr: null, activities: [] });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockReportException).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("reports diagnostic query failures to Sentry", async () => {
    const diagnosticError = new Error("diagnostic query failed");
    const sensorStore = makeSequentialSensorStore([]);
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([]) // read model returns empty
      .mockResolvedValueOnce([]) // deduped_sensor returns empty → triggers diagnostics
      .mockRejectedValueOnce(diagnosticError); // sample diagnostic fails → caught by .catch()
    const { repo, execute } = makeRepositoryWithSensorStore(sensorStore);
    execute.mockResolvedValueOnce([{ max_hr: 190, endurance_activities: 1 }]);
    const mockReportException = vi.mocked(reportException);
    mockReportException.mockClear();

    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(90));

    expect(result).toEqual({ maxHr: null, activities: [] });
    expect(mockReportException).toHaveBeenCalledWith(diagnosticError);
  });

  it("maps rows to AerobicEfficiencyActivity objects", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Morning Ride",
        avg_power_z2: "180.5",
        avg_hr_z2: "135.2",
        efficiency_factor: "1.335",
        z2_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));

    expect(result.maxHr).toBe(190);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toEqual({
      date: "2025-06-01",
      activityType: "cycling",
      name: "Morning Ride",
      avgPowerZ2: 180.5,
      avgHrZ2: 135.2,
      efficiencyFactor: 1.335,
      z2Samples: 1800,
    });
  });

  it("converts numeric string fields to proper numbers", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180.5",
        avg_hr_z2: "135.2",
        efficiency_factor: "1.335",
        z2_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    // Verify that Number() conversions actually happen
    expect(typeof result.activities[0]?.avgPowerZ2).toBe("number");
    expect(typeof result.activities[0]?.avgHrZ2).toBe("number");
    expect(typeof result.activities[0]?.efficiencyFactor).toBe("number");
    expect(typeof result.activities[0]?.z2Samples).toBe("number");
    expect(result.activities[0]?.avgPowerZ2).toBe(180.5);
    expect(result.activities[0]?.avgHrZ2).toBe(135.2);
    expect(result.activities[0]?.efficiencyFactor).toBe(1.335);
    expect(result.activities[0]?.z2Samples).toBe(1800);
  });

  it("returns maxHr as number from first row when rows exist (rows.length > 0)", async () => {
    // This tests the boundary: rows.length > 0 vs >= 0
    // With exactly 1 row, maxHr should be extracted (not null)
    const { repo } = makeRepository([
      {
        max_hr: "192",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "400",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(result.maxHr).toBe(192);
    expect(result.maxHr).not.toBeNull();
  });

  it("extracts maxHr from first row", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "185",
        date: "2025-06-01",
        canonical_type: "running",
        name: "Easy Run",
        avg_power_z2: "250",
        avg_hr_z2: "140",
        efficiency_factor: "1.786",
        z2_samples: "600",
      },
      {
        max_hr: "185",
        date: "2025-06-02",
        canonical_type: "cycling",
        name: "Zone 2 Ride",
        avg_power_z2: "175",
        avg_hr_z2: "130",
        efficiency_factor: "1.346",
        z2_samples: "3600",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(result.maxHr).toBe(185);
    expect(result.activities).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getAerobicDecoupling
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicDecoupling", () => {
  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    expect(result).toEqual([]);
  });

  it("issues exactly one CH query", async () => {
    const { repo, sensorStore } = makeRepository([]);
    await repo.getAerobicDecoupling(ChartRange.fromDays(90));
    expect(sensorStore.query).toHaveBeenCalledTimes(1);
  });

  it("filters decoupling to cycling activity types", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getAerobicDecoupling(ChartRange.fromDays(90));

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).toContain("has({activityTypes:Array(String)}, asum.canonical_type)");
    expect(queryText).not.toContain("enduranceTypes");
    expectCyclingOnlyActivityTypes(vi.mocked(sensorStore.query).mock.calls[0]?.[2]?.activityTypes);
  });

  it("keeps lower-bound filters for finite day ranges", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getAerobicDecoupling(ChartRange.fromDays(90));

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).toContain("asum.started_at > now() - INTERVAL {days:Int32} DAY");
    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toHaveProperty("days", 90);
  });

  it("omits lower-bound filters when days is null", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getAerobicDecoupling(ChartRange.fromDays(null));

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).not.toContain("asum.started_at > now() - INTERVAL");
    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).not.toHaveProperty("days");
  });

  it("maps rows to AerobicDecouplingActivity objects", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Long Ride",
        first_half_ratio: "1.350",
        second_half_ratio: "1.280",
        decoupling_pct: "5.19",
        total_samples: "7200",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      date: "2025-06-01",
      activityType: "cycling",
      name: "Long Ride",
      firstHalfRatio: 1.35,
      secondHalfRatio: 1.28,
      decouplingPct: 5.19,
      totalSamples: 7200,
    });
  });

  it("returns multiple activities in order", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride A",
        first_half_ratio: "1.400",
        second_half_ratio: "1.350",
        decoupling_pct: "3.57",
        total_samples: "3600",
      },
      {
        date: "2025-06-03",
        canonical_type: "running",
        name: "Run B",
        first_half_ratio: "1.200",
        second_half_ratio: "1.100",
        decoupling_pct: "8.33",
        total_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    expect(result).toHaveLength(2);
    expect(result[0]?.activityType).toBe("cycling");
    expect(result[1]?.activityType).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// getPolarizationTrend
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getPolarizationTrend", () => {
  it("returns null maxHr and empty weeks when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(result).toEqual({
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
      maxHr: null,
      weeks: [],
      explanation: expect.stringContaining("cycling"),
      method: expect.objectContaining({
        formula: expect.stringContaining("log10"),
        interpretation: expect.stringContaining("not a physiological or medical assessment"),
      }),
    });
  });

  it("returns fresh method metadata for each result", async () => {
    const { repo } = makeRepository([]);

    const firstResult = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    firstResult.method.source.title = "Mutated source";

    const secondResult = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(secondResult.method.source.title).toBe("Treff et al. (2019), The Polarization-Index");
  });

  it("uses one read-model query when no rows exist", async () => {
    const { repo, sensorStore } = makeRepository([]);
    await repo.getPolarizationTrend(ChartRange.fromDays(90));
    expect(sensorStore.query).toHaveBeenCalledTimes(1);
  });

  it("filters the polarization read model to cycling activity types", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getPolarizationTrend(ChartRange.fromDays(90));

    const readModelQuery = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(readModelQuery).toContain("has({activityTypes:Array(String)}, canonical_type)");
    expect(readModelQuery).not.toContain("enduranceTypes");
    expectCyclingOnlyActivityTypes(vi.mocked(sensorStore.query).mock.calls[0]?.[2]?.activityTypes);
  });

  it("keeps lower-bound filters for finite day ranges", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getPolarizationTrend(ChartRange.fromDays(90));

    const readModelCall = vi.mocked(sensorStore.query).mock.calls[0];
    expect(readModelCall?.[1]).toContain("started_at > now() - INTERVAL {days:Int32} DAY");
    expect(readModelCall?.[2]).toHaveProperty("days", 90);
  });

  it("omits lower-bound filters when days is null", async () => {
    const { repo, sensorStore } = makeRepository([]);

    await repo.getPolarizationTrend(ChartRange.fromDays(null));

    const readModelCall = vi.mocked(sensorStore.query).mock.calls[0];
    expect(readModelCall?.[1]).not.toContain("started_at > now() - INTERVAL");
    expect(readModelCall?.[2]).not.toHaveProperty("days");
  });

  it("returns maxHr as number (not null) when rows.length > 0", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "188",
        week: "2025-05-26",
        z1_seconds: "3000",
        z2_seconds: "1000",
        z3_seconds: "500",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(result.maxHr).toBe(188);
    expect(result.maxHr).not.toBeNull();
  });

  it("maps rows and computes polarization index", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "5000",
        z2_seconds: "1000",
        z3_seconds: "500",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));

    expect(result.maxHr).toBe(190);
    expect(result.weeks).toHaveLength(1);

    const week = result.weeks[0];
    expect(week?.week).toBe("2025-05-26");
    expect(week?.z1Seconds).toBe(5000);
    expect(week?.z2Seconds).toBe(1000);
    expect(week?.z3Seconds).toBe(500);
    // Verify polarization index matches the shared function
    expect(week?.polarizationIndex).toBe(computePolarizationIndex(5000, 1000, 500));
    expect(week).toMatchObject({
      totalSeconds: 6500,
      zonePercentages: { z1: 76.9, z2: 15.4, z3: 7.7 },
      statusLabel: expect.any(String),
      explanation: expect.any(String),
    });
    expect(result.method).toEqual({
      formula:
        "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
      zoneBasis:
        "Easy zone (Zone 1) is below 80%, threshold zone (Zone 2) is 80–<90%, and high zone (Zone 3) is at least 90% of maximum heart rate.",
      calculationChoice:
        "Dofek requires recorded time in all three zones and does not calculate the polarization index when high-zone time exceeds easy-zone time.",
      interpretation:
        "The >2.00 comparison is Treff's descriptive training-distribution heuristic, not a physiological or medical assessment.",
      source: {
        title: "Treff et al. (2019), The Polarization-Index",
        url: "https://doi.org/10.3389/fphys.2019.00707",
      },
    });
  });

  it("computes polarization index as null when zone fractions are zero", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "0",
        z2_seconds: "0",
        z3_seconds: "0",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    // computePolarizationIndex returns null when total is zero
    expect(result.weeks[0]?.polarizationIndex).toBe(computePolarizationIndex(0, 0, 0));
  });

  it("returns multiple weeks", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "185",
        week: "2025-05-19",
        z1_seconds: "4000",
        z2_seconds: "800",
        z3_seconds: "200",
      },
      {
        max_hr: "185",
        week: "2025-05-26",
        z1_seconds: "3500",
        z2_seconds: "1200",
        z3_seconds: "300",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(result.maxHr).toBe(185);
    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0]?.week).toBe("2025-05-19");
    expect(result.weeks[1]?.week).toBe("2025-05-26");
  });

  it("returns null maxHr when rows is empty (rows.length > 0 boundary)", async () => {
    // Specifically verifies that `rows.length > 0` is the condition, not `rows.length >= 0`
    // With 0 rows: maxHr must be null
    const { repo: emptyRepo } = makeRepository([]);
    const emptyResult = await emptyRepo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(emptyResult.maxHr).toBeNull();

    // With 1 row: maxHr must NOT be null
    const { repo: oneRowRepo } = makeRepository([
      {
        max_hr: "195",
        week: "2025-06-02",
        z1_seconds: "100",
        z2_seconds: "100",
        z3_seconds: "100",
      },
    ]);
    const oneRowResult = await oneRowRepo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(oneRowResult.maxHr).toBe(195);
    expect(oneRowResult.maxHr).not.toBeNull();
  });

  it("converts zone seconds to numbers for polarization index", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "7200",
        z2_seconds: "600",
        z3_seconds: "1200",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    const week = result.weeks[0];
    expect(week?.z1Seconds).toBe(7200);
    expect(week?.z2Seconds).toBe(600);
    expect(week?.z3Seconds).toBe(1200);
    // The polarization index should match the shared computation
    expect(week?.polarizationIndex).toBe(computePolarizationIndex(7200, 600, 1200));
  });
});

// ---------------------------------------------------------------------------
// getAerobicEfficiency — rows.length > 0 boundary
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency (rows.length boundary)", () => {
  it("returns null maxHr when rows.length is 0, non-null when >= 1", async () => {
    // 0 rows => null
    const { repo: repoEmpty } = makeRepository([]);
    const emptyResult = await repoEmpty.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(emptyResult.maxHr).toBeNull();

    // 1 row => Number(rows[0].max_hr)
    const { repo: repoOne } = makeRepository([
      {
        max_hr: "200",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "500",
      },
    ]);
    const oneResult = await repoOne.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(oneResult.maxHr).toBe(200);
    expect(oneResult.maxHr).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAerobicEfficiency — String() conversions in map
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency (String conversions)", () => {
  it("uses String() for date, activityType, and name fields", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-07-01",
        canonical_type: "running",
        name: "Tempo Run",
        avg_power_z2: "200",
        avg_hr_z2: "140",
        efficiency_factor: "1.429",
        z2_samples: "500",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    const activity = result.activities[0];
    expect(typeof activity?.date).toBe("string");
    expect(typeof activity?.activityType).toBe("string");
    expect(typeof activity?.name).toBe("string");
    expect(activity?.date).toBe("2025-07-01");
    expect(activity?.activityType).toBe("running");
    expect(activity?.name).toBe("Tempo Run");
  });
});

// ---------------------------------------------------------------------------
// getAerobicDecoupling — String() conversions in map
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicDecoupling (String conversions)", () => {
  it("uses String() for date, activityType, and name fields", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-07-01",
        canonical_type: "running",
        name: "Easy Run",
        first_half_ratio: "1.250",
        second_half_ratio: "1.200",
        decoupling_pct: "4.00",
        total_samples: "2400",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    const activity = result[0];
    expect(typeof activity?.date).toBe("string");
    expect(typeof activity?.activityType).toBe("string");
    expect(typeof activity?.name).toBe("string");
    expect(activity?.date).toBe("2025-07-01");
    expect(activity?.activityType).toBe("running");
    expect(activity?.name).toBe("Easy Run");
  });

  it("converts numeric string fields to numbers", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-07-01",
        canonical_type: "cycling",
        name: "Ride",
        first_half_ratio: "1.333",
        second_half_ratio: "1.222",
        decoupling_pct: "8.33",
        total_samples: "5000",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    const activity = result[0];
    expect(typeof activity?.firstHalfRatio).toBe("number");
    expect(typeof activity?.secondHalfRatio).toBe("number");
    expect(typeof activity?.decouplingPct).toBe("number");
    expect(typeof activity?.totalSamples).toBe("number");
    expect(activity?.firstHalfRatio).toBe(1.333);
    expect(activity?.secondHalfRatio).toBe(1.222);
    expect(activity?.decouplingPct).toBe(8.33);
    expect(activity?.totalSamples).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// getPolarizationTrend — String() conversions in map
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getPolarizationTrend (String conversion)", () => {
  it("uses String() for week field", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-06-02",
        z1_seconds: "3600",
        z2_seconds: "1200",
        z3_seconds: "600",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(typeof result.weeks[0]?.week).toBe("string");
    expect(result.weeks[0]?.week).toBe("2025-06-02");
  });

  it("uses Number() for maxHr from first row", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "193",
        week: "2025-06-02",
        z1_seconds: "100",
        z2_seconds: "100",
        z3_seconds: "100",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(typeof result.maxHr).toBe("number");
    expect(result.maxHr).toBe(193);
  });
});

// ---------------------------------------------------------------------------
// Mutation-killing tests: object literal shapes
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency (object shape)", () => {
  it("returns result with exactly maxHr and activities keys", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    expect(Object.keys(result).sort()).toStrictEqual(["activities", "maxHr"]);
  });

  it("each activity has all 7 required properties", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "500",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    const activity = result.activities[0];
    expect(Object.keys(activity ?? {}).sort()).toStrictEqual([
      "activityType",
      "avgHrZ2",
      "avgPowerZ2",
      "date",
      "efficiencyFactor",
      "name",
      "z2Samples",
    ]);
  });
});

describe("EfficiencyRepository.getAerobicDecoupling (object shape)", () => {
  it("each activity has all 7 required properties", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        first_half_ratio: "1.350",
        second_half_ratio: "1.280",
        decoupling_pct: "5.19",
        total_samples: "7200",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    expect(Object.keys(result[0] ?? {}).sort()).toStrictEqual([
      "activityType",
      "date",
      "decouplingPct",
      "firstHalfRatio",
      "name",
      "secondHalfRatio",
      "totalSamples",
    ]);
  });
});

describe("EfficiencyRepository.getPolarizationTrend (object shape)", () => {
  it("returns the complete Treff result model", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(Object.keys(result).sort()).toStrictEqual([
      "activityScope",
      "explanation",
      "maxHr",
      "method",
      "model",
      "threshold",
      "weeks",
    ]);
  });

  it("each week includes the server-owned classification and percentages", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "5000",
        z2_seconds: "1000",
        z3_seconds: "500",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    expect(Object.keys(result.weeks[0] ?? {}).sort()).toStrictEqual([
      "explanation",
      "polarizationIndex",
      "status",
      "statusLabel",
      "totalSeconds",
      "week",
      "z1Seconds",
      "z2Seconds",
      "z3Seconds",
      "zonePercentages",
    ]);
  });

  it("zone seconds are passed to computePolarizationIndex in correct order (z1, z2, z3)", async () => {
    // If z1 and z2 were swapped, the polarization index would differ
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "7200",
        z2_seconds: "300",
        z3_seconds: "1500",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    const week = result.weeks[0];
    // Correct order: z1=7200, z2=300, z3=1500
    const expectedIndex = computePolarizationIndex(7200, 300, 1500);
    // Swapped order would give different result
    const swappedIndex = computePolarizationIndex(300, 7200, 1500);
    expect(expectedIndex).not.toBe(swappedIndex);
    expect(week?.polarizationIndex).toBe(expectedIndex);
  });
});

// ---------------------------------------------------------------------------
// Mutation-killing tests: exact field mapping correctness
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency (mutation: field mapping)", () => {
  it("maps avg_power_z2 to avgPowerZ2, not to avgHrZ2 or other field", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "200",
        avg_hr_z2: "140",
        efficiency_factor: "1.429",
        z2_samples: "500",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    const activity = result.activities[0];
    // If field mapping were swapped (avgPowerZ2 ↔ avgHrZ2), values would be wrong
    expect(activity?.avgPowerZ2).toBe(200);
    expect(activity?.avgHrZ2).toBe(140);
    expect(activity?.avgPowerZ2).not.toBe(140);
    expect(activity?.avgHrZ2).not.toBe(200);
  });

  it("efficiencyFactor and z2Samples are mapped to their exact fields", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "900",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    const activity = result.activities[0];
    // These two fields should not be swapped
    expect(activity?.efficiencyFactor).toBe(1.333);
    expect(activity?.z2Samples).toBe(900);
    expect(activity?.efficiencyFactor).not.toBe(900);
    expect(activity?.z2Samples).not.toBe(1.333);
  });
});

describe("EfficiencyRepository.getAerobicDecoupling (mutation: field mapping)", () => {
  it("maps firstHalfRatio and secondHalfRatio to their exact fields", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        first_half_ratio: "1.500",
        second_half_ratio: "1.200",
        decoupling_pct: "20.00",
        total_samples: "3000",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    const activity = result[0];
    // If first/second were swapped, values would be wrong
    expect(activity?.firstHalfRatio).toBe(1.5);
    expect(activity?.secondHalfRatio).toBe(1.2);
    expect(activity?.firstHalfRatio).not.toBe(1.2);
    expect(activity?.secondHalfRatio).not.toBe(1.5);
  });

  it("maps decouplingPct and totalSamples to their exact fields", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        first_half_ratio: "1.350",
        second_half_ratio: "1.280",
        decoupling_pct: "5.19",
        total_samples: "7200",
      },
    ]);
    const result = await repo.getAerobicDecoupling(ChartRange.fromDays(180));
    const activity = result[0];
    expect(activity?.decouplingPct).toBe(5.19);
    expect(activity?.totalSamples).toBe(7200);
    expect(activity?.decouplingPct).not.toBe(7200);
    expect(activity?.totalSamples).not.toBe(5.19);
  });
});

describe("EfficiencyRepository.getPolarizationTrend (mutation: field mapping)", () => {
  it("maps z1, z2, z3 seconds to their exact fields", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        week: "2025-05-26",
        z1_seconds: "4000",
        z2_seconds: "2000",
        z3_seconds: "1000",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    const week = result.weeks[0];
    // Each zone must map to its correct field
    expect(week?.z1Seconds).toBe(4000);
    expect(week?.z2Seconds).toBe(2000);
    expect(week?.z3Seconds).toBe(1000);
    // Verify they are not swapped
    expect(week?.z1Seconds).not.toBe(2000);
    expect(week?.z2Seconds).not.toBe(4000);
    expect(week?.z3Seconds).not.toBe(4000);
  });

  it("maxHr uses Number() conversion from first row", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "187",
        week: "2025-06-02",
        z1_seconds: "100",
        z2_seconds: "100",
        z3_seconds: "100",
      },
    ]);
    const result = await repo.getPolarizationTrend(ChartRange.fromDays(180));
    // Number("187") = 187, not String("187")
    expect(result.maxHr).toStrictEqual(187);
    expect(typeof result.maxHr).toBe("number");
  });
});

describe("EfficiencyRepository.getAerobicEfficiency (mutation: maxHr ternary)", () => {
  it("maxHr is extracted from the first row (index 0), not a later row", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "185",
        date: "2025-06-01",
        canonical_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "500",
      },
      {
        max_hr: "190",
        date: "2025-06-02",
        canonical_type: "cycling",
        name: "Ride 2",
        avg_power_z2: "175",
        avg_hr_z2: "132",
        efficiency_factor: "1.326",
        z2_samples: "400",
      },
    ]);
    const result = await repo.getAerobicEfficiency(ChartRange.fromDays(180));
    // Should come from rows[0].max_hr, not rows[1].max_hr
    expect(result.maxHr).toBe(185);
    expect(result.maxHr).not.toBe(190);
  });
});
