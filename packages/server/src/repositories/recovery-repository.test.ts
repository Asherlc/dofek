import { describe, expect, it, vi } from "vitest";
import {
  HrvVariabilityDay,
  RecoveryRepository,
  SleepConsistencyDay,
  SleepNight,
  WorkloadDay,
  computeReadinessComponents,
  computeSleepDebt,
  computeStrainTargetResult,
  computeWorkloadResult,
} from "./recovery-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("SleepConsistencyDay", () => {
  function makeRow(overrides: Partial<SleepConsistencyDay["toDetail"]> = {}) {
    return {
      date: "2024-03-15",
      bedtimeHour: 22.5,
      waketimeHour: 6.75,
      rollingBedtimeStddev: 0.456,
      rollingWaketimeStddev: 0.312,
      windowCount: 14,
      ...overrides,
    };
  }

  it("rounds bedtime and waketime hours to 2 decimals", () => {
    const day = new SleepConsistencyDay(
      makeRow({ bedtimeHour: 22.5678, waketimeHour: 6.1234 }),
    );
    expect(day.bedtimeHour).toBe(22.57);
    expect(day.waketimeHour).toBe(6.12);
  });

  it("rounds rolling stddev to 2 decimals", () => {
    const day = new SleepConsistencyDay(
      makeRow({
        rollingBedtimeStddev: 1.23456,
        rollingWaketimeStddev: 0.98765,
      }),
    );
    expect(day.rollingBedtimeStddev).toBe(1.23);
    expect(day.rollingWaketimeStddev).toBe(0.99);
  });

  it("returns null stddev when source is null", () => {
    const day = new SleepConsistencyDay(
      makeRow({
        rollingBedtimeStddev: null,
        rollingWaketimeStddev: null,
      }),
    );
    expect(day.rollingBedtimeStddev).toBeNull();
    expect(day.rollingWaketimeStddev).toBeNull();
  });

  it("returns null consistency score when window count is below 7", () => {
    const day = new SleepConsistencyDay(makeRow({ windowCount: 5 }));
    expect(day.consistencyScore).toBeNull();
  });

  it("returns a consistency score when window count is 7 or more", () => {
    const day = new SleepConsistencyDay(makeRow({ windowCount: 14 }));
    expect(day.consistencyScore).toBeTypeOf("number");
  });

  it("serializes to API shape via toDetail()", () => {
    const day = new SleepConsistencyDay(makeRow());
    const detail = day.toDetail();
    expect(detail.date).toBe("2024-03-15");
    expect(typeof detail.bedtimeHour).toBe("number");
    expect(typeof detail.waketimeHour).toBe("number");
    expect(detail).toHaveProperty("consistencyScore");
  });
});

describe("HrvVariabilityDay", () => {
  it("rounds hrv to 1 decimal", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45.678,
      rollingMean: 50.123,
      rollingCoefficientOfVariation: 12.3456,
    });
    const detail = day.toDetail();
    expect(detail.hrv).toBe(45.7);
  });

  it("rounds rolling mean to 1 decimal", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45,
      rollingMean: 50.456,
      rollingCoefficientOfVariation: null,
    });
    expect(day.toDetail().rollingMean).toBe(50.5);
  });

  it("rounds CV to 2 decimals", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45,
      rollingMean: 50,
      rollingCoefficientOfVariation: 12.3456,
    });
    expect(day.toDetail().rollingCoefficientOfVariation).toBe(12.35);
  });

  it("preserves null fields", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: null,
      rollingMean: null,
      rollingCoefficientOfVariation: null,
    });
    const detail = day.toDetail();
    expect(detail.hrv).toBeNull();
    expect(detail.rollingMean).toBeNull();
    expect(detail.rollingCoefficientOfVariation).toBeNull();
  });
});

describe("WorkloadDay", () => {
  function makeRow(overrides: Partial<WorkloadDay["toDetail"]> = {}) {
    return {
      date: "2024-03-15",
      dailyLoad: 150.456,
      acuteLoad: 800.123,
      chronicLoad: 700.987,
      workloadRatio: 1.14,
      ...overrides,
    };
  }

  it("rounds daily load to 1 decimal", () => {
    const day = new WorkloadDay(makeRow({ dailyLoad: 150.456 }));
    expect(day.dailyLoad).toBe(150.5);
  });

  it("computes strain from daily load", () => {
    const day = new WorkloadDay(makeRow({ dailyLoad: 200 }));
    expect(day.strain).toBeTypeOf("number");
    expect(day.strain).toBeGreaterThanOrEqual(0);
  });

  it("rounds acute and chronic load to 1 decimal", () => {
    const day = new WorkloadDay(
      makeRow({ acuteLoad: 800.456, chronicLoad: 700.321 }),
    );
    expect(day.acuteLoad).toBe(800.5);
    expect(day.chronicLoad).toBe(700.3);
  });

  it("rounds workload ratio to 2 decimals", () => {
    const day = new WorkloadDay(makeRow({ workloadRatio: 1.1456 }));
    expect(day.workloadRatio).toBe(1.15);
  });

  it("returns null workload ratio when source is null", () => {
    const day = new WorkloadDay(makeRow({ workloadRatio: null }));
    expect(day.workloadRatio).toBeNull();
  });

  it("serializes to API shape via toDetail()", () => {
    const day = new WorkloadDay(makeRow());
    const detail = day.toDetail();
    expect(detail).toHaveProperty("date");
    expect(detail).toHaveProperty("dailyLoad");
    expect(detail).toHaveProperty("strain");
    expect(detail).toHaveProperty("acuteLoad");
    expect(detail).toHaveProperty("chronicLoad");
    expect(detail).toHaveProperty("workloadRatio");
  });
});

describe("computeWorkloadResult", () => {
  it("returns empty timeSeries with zero displayed strain when no data", () => {
    const result = computeWorkloadResult([]);
    expect(result.timeSeries).toEqual([]);
    expect(result.displayedStrain).toBe(0);
    expect(result.displayedDate).toBeNull();
  });

  it("includes strain in each time series entry", () => {
    const days = [
      new WorkloadDay({
        date: "2024-03-15",
        dailyLoad: 100,
        acuteLoad: 500,
        chronicLoad: 400,
        workloadRatio: 1.25,
      }),
    ];
    const result = computeWorkloadResult(days);
    expect(result.timeSeries).toHaveLength(1);
    expect(result.timeSeries[0]).toHaveProperty("strain");
  });
});

describe("SleepNight", () => {
  function makeRow() {
    return {
      date: "2024-03-15",
      durationMinutes: 480,
      sleepMinutes: 420,
      deepPct: 20.456,
      remPct: 25.123,
      lightPct: 45.321,
      awakePct: 9.1,
      efficiency: 87.5,
      rollingAvgDuration: 415.678,
    };
  }

  it("rounds stage percentages to 1 decimal", () => {
    const night = new SleepNight(makeRow());
    const detail = night.toDetail();
    expect(detail.deepPct).toBe(20.5);
    expect(detail.remPct).toBe(25.1);
    expect(detail.lightPct).toBe(45.3);
    expect(detail.awakePct).toBe(9.1);
  });

  it("rounds efficiency to 1 decimal", () => {
    const night = new SleepNight(makeRow());
    expect(night.toDetail().efficiency).toBe(87.5);
  });

  it("rounds rolling avg duration to 1 decimal", () => {
    const night = new SleepNight(makeRow());
    expect(night.toDetail().rollingAvgDuration).toBe(415.7);
  });

  it("returns null rolling avg when source is null", () => {
    const night = new SleepNight({ ...makeRow(), rollingAvgDuration: null });
    expect(night.toDetail().rollingAvgDuration).toBeNull();
  });

  it("exposes sleepMinutes for debt calculation", () => {
    const night = new SleepNight(makeRow());
    expect(night.sleepMinutes).toBe(420);
  });
});

describe("computeSleepDebt", () => {
  it("computes positive debt when under target", () => {
    const nights = [
      new SleepNight({
        date: "2024-03-15",
        durationMinutes: 400,
        sleepMinutes: 400,
        deepPct: 20,
        remPct: 25,
        lightPct: 45,
        awakePct: 10,
        efficiency: 85,
        rollingAvgDuration: null,
      }),
    ];
    const debt = computeSleepDebt(nights, 480);
    expect(debt).toBe(80);
  });

  it("computes negative debt (surplus) when over target", () => {
    const nights = [
      new SleepNight({
        date: "2024-03-15",
        durationMinutes: 540,
        sleepMinutes: 540,
        deepPct: 20,
        remPct: 25,
        lightPct: 45,
        awakePct: 10,
        efficiency: 90,
        rollingAvgDuration: null,
      }),
    ];
    const debt = computeSleepDebt(nights, 480);
    expect(debt).toBe(-60);
  });

  it("only uses last 14 nights", () => {
    const nights: SleepNight[] = [];
    for (let index = 0; index < 20; index++) {
      nights.push(
        new SleepNight({
          date: `2024-03-${String(index + 1).padStart(2, "0")}`,
          durationMinutes: 400,
          sleepMinutes: 400,
          deepPct: 20,
          remPct: 25,
          lightPct: 45,
          awakePct: 10,
          efficiency: 85,
          rollingAvgDuration: null,
        }),
      );
    }
    const debt = computeSleepDebt(nights, 480);
    // 14 nights * 80 min deficit each = 1120
    expect(debt).toBe(1120);
  });

  it("returns 0 when no nights", () => {
    expect(computeSleepDebt([], 480)).toBe(0);
  });
});

describe("computeReadinessComponents", () => {
  it("returns default scores when all metrics are null", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    });
    expect(components.hrvScore).toBe(62);
    expect(components.restingHrScore).toBe(62);
    expect(components.sleepScore).toBe(62);
    expect(components.respiratoryRateScore).toBe(62);
  });

  it("scores high HRV above baseline higher", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: 70,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: 50,
      hrvSd30d: 10,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    });
    expect(components.hrvScore).toBeGreaterThan(62);
  });

  it("scores low HRV below baseline lower", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: 30,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: 50,
      hrvSd30d: 10,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    });
    expect(components.hrvScore).toBeLessThan(62);
  });

  it("scores lower resting HR better (inverted z)", () => {
    const low = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: 50,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: 60,
      rhrSd30d: 5,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    });
    const high = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: 70,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: 60,
      rhrSd30d: 5,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    });
    expect(low.restingHrScore).toBeGreaterThan(high.restingHrScore);
  });

  it("maps sleep efficiency directly to score clamped 0-100", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: 95,
    });
    expect(components.sleepScore).toBe(95);
  });

  it("clamps sleep efficiency to 0-100", () => {
    const over = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: 110,
    });
    expect(over.sleepScore).toBe(100);

    const under = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: null,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: -5,
    });
    expect(under.sleepScore).toBe(0);
  });

  it("returns default when stddev is 0 (no variation)", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: 50,
      restingHr: 60,
      respiratoryRate: 15,
      hrvMean30d: 50,
      hrvSd30d: 0,
      rhrMean30d: 60,
      rhrSd30d: 0,
      rrMean30d: 15,
      rrSd30d: 0,
      efficiencyPct: null,
    });
    expect(components.hrvScore).toBe(62);
    expect(components.restingHrScore).toBe(62);
    expect(components.respiratoryRateScore).toBe(62);
  });
});

describe("computeStrainTargetResult", () => {
  it("returns strain target with zone and explanation", () => {
    const result = computeStrainTargetResult({
      readinessScore: 80,
      chronicLoad: 100,
      acuteLoad: 90,
      currentStrain: 5,
    });
    expect(result).toHaveProperty("targetStrain");
    expect(result).toHaveProperty("currentStrain");
    expect(result).toHaveProperty("progressPercent");
    expect(result).toHaveProperty("zone");
    expect(result).toHaveProperty("explanation");
    expect(["Push", "Maintain", "Recovery"]).toContain(result.zone);
  });

  it("rounds current strain to 1 decimal", () => {
    const result = computeStrainTargetResult({
      readinessScore: 50,
      chronicLoad: 100,
      acuteLoad: 90,
      currentStrain: 5.456,
    });
    expect(result.currentStrain).toBe(5.5);
  });

  it("returns 0 progress when target is 0", () => {
    const result = computeStrainTargetResult({
      readinessScore: 10,
      chronicLoad: 0,
      acuteLoad: 0,
      currentStrain: 0,
    });
    expect(result.progressPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("RecoveryRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new RecoveryRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getSleepConsistency", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getSleepConsistency(90);
      expect(result).toEqual([]);
    });

    it("returns SleepConsistencyDay instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.75,
          rolling_bedtime_stddev: 0.5,
          rolling_waketime_stddev: 0.3,
          window_count: 14,
        },
      ]);
      const result = await repo.getSleepConsistency(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(SleepConsistencyDay);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getSleepConsistency(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getHrvVariability", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getHrvVariability(90);
      expect(result).toEqual([]);
    });

    it("returns HrvVariabilityDay instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          hrv: 45,
          rolling_mean: 50,
          rolling_cv: 12.5,
        },
      ]);
      const result = await repo.getHrvVariability(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HrvVariabilityDay);
    });
  });

  describe("getWorkloadRatio", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWorkloadRatio(90, "2024-03-15");
      expect(result).toEqual([]);
    });

    it("returns WorkloadDay instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          daily_load: 150,
          acute_load: 800,
          chronic_load: 700,
          workload_ratio: 1.14,
        },
      ]);
      const result = await repo.getWorkloadRatio(90, "2024-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(WorkloadDay);
    });

    it("handles null workload ratio", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          daily_load: 150,
          acute_load: 800,
          chronic_load: 700,
          workload_ratio: null,
        },
      ]);
      const result = await repo.getWorkloadRatio(90, "2024-03-15");
      expect(result[0]?.workloadRatio).toBeNull();
    });
  });

  describe("getSleepNights", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getSleepNights(90);
      expect(result).toEqual([]);
    });

    it("returns SleepNight instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          duration_minutes: 480,
          sleep_minutes: 420,
          deep_pct: 20,
          rem_pct: 25,
          light_pct: 45,
          awake_pct: 10,
          efficiency: 87.5,
          rolling_avg_duration: 415,
        },
      ]);
      const result = await repo.getSleepNights(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(SleepNight);
      expect(result[0]?.sleepMinutes).toBe(420);
    });
  });

  describe("getReadinessMetrics", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getReadinessMetrics(30, "2024-03-15");
      expect(result).toEqual([]);
    });

    it("returns mapped readiness rows", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          hrv: 50,
          resting_hr: 60,
          respiratory_rate: 15,
          hrv_mean_30d: 48,
          hrv_sd_30d: 8,
          rhr_mean_30d: 62,
          rhr_sd_30d: 3,
          rr_mean_30d: 14.5,
          rr_sd_30d: 1,
          efficiency_pct: 90,
        },
      ]);
      const result = await repo.getReadinessMetrics(30, "2024-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.hrv).toBe(50);
      expect(result[0]?.efficiencyPct).toBe(90);
    });

    it("handles null values", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          hrv: null,
          resting_hr: null,
          respiratory_rate: null,
          hrv_mean_30d: null,
          hrv_sd_30d: null,
          rhr_mean_30d: null,
          rhr_sd_30d: null,
          rr_mean_30d: null,
          rr_sd_30d: null,
          efficiency_pct: null,
        },
      ]);
      const result = await repo.getReadinessMetrics(30, "2024-03-15");
      expect(result[0]?.hrv).toBeNull();
      expect(result[0]?.efficiencyPct).toBeNull();
    });
  });
});
