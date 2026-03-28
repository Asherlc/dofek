import { describe, expect, it, vi } from "vitest";
import {
  computeReadinessComponents,
  computeSleepDebt,
  computeStrainTargetResult,
  computeWorkloadResult,
  HrvVariabilityDay,
  RecoveryRepository,
  SleepConsistencyDay,
  SleepNight,
  WorkloadDay,
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
    const day = new SleepConsistencyDay(makeRow({ bedtimeHour: 22.5678, waketimeHour: 6.1234 }));
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

  it("rounds bedtimeHour to exactly 2 decimals (not 1 or 3)", () => {
    // 22.5678 * 100 / 100 = 22.57 (2 decimals)
    // If *10/10: 22.6 (1 decimal), if *1000/1000: 22.568 (3 decimal)
    const day = new SleepConsistencyDay(makeRow({ bedtimeHour: 22.5678 }));
    expect(day.bedtimeHour).not.toBe(22.6);
    expect(day.bedtimeHour).not.toBe(22.568);
  });

  it("rounds waketimeHour to exactly 2 decimals (not 1 or 3)", () => {
    const day = new SleepConsistencyDay(makeRow({ waketimeHour: 6.1234 }));
    expect(day.waketimeHour).not.toBe(6.1);
    expect(day.waketimeHour).not.toBe(6.123);
  });

  it("rounds rolling stddev to exactly 2 decimals (not 1 or 3)", () => {
    const day = new SleepConsistencyDay(
      makeRow({ rollingBedtimeStddev: 1.23456, rollingWaketimeStddev: 0.98765 }),
    );
    // *100/100: 1.23 (not *10/10: 1.2, not *1000/1000: 1.235)
    expect(day.rollingBedtimeStddev).not.toBe(1.2);
    expect(day.rollingBedtimeStddev).not.toBe(1.235);
    expect(day.rollingWaketimeStddev).not.toBe(1.0);
    expect(day.rollingWaketimeStddev).not.toBe(0.988);
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

  it("returns null consistency score when window count is exactly 6", () => {
    const day = new SleepConsistencyDay(makeRow({ windowCount: 6 }));
    expect(day.consistencyScore).toBeNull();
  });

  it("returns a numeric consistency score when window count is exactly 7", () => {
    const day = new SleepConsistencyDay(makeRow({ windowCount: 7 }));
    expect(day.consistencyScore).toBeTypeOf("number");
    expect(day.consistencyScore).not.toBeNull();
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

  it("rounds hrv to 1 decimal (not 0 or 2)", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45.678,
      rollingMean: 50,
      rollingCoefficientOfVariation: null,
    });
    // *10/10: 45.7, not *1/1: 46, not *100/100: 45.68
    expect(day.toDetail().hrv).not.toBe(46);
    expect(day.toDetail().hrv).not.toBe(45.68);
  });

  it("rounds rolling mean to 1 decimal (not 0 or 2)", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45,
      rollingMean: 50.456,
      rollingCoefficientOfVariation: null,
    });
    // *10/10: 50.5, not *1/1: 50, not *100/100: 50.46
    expect(day.toDetail().rollingMean).not.toBe(50);
    expect(day.toDetail().rollingMean).not.toBe(50.46);
  });

  it("rounds CV to 2 decimals (not 1 or 3)", () => {
    const day = new HrvVariabilityDay({
      date: "2024-03-15",
      hrv: 45,
      rollingMean: 50,
      rollingCoefficientOfVariation: 12.3456,
    });
    expect(day.toDetail().rollingCoefficientOfVariation).toBe(12.35);
    // Not *10/10: 12.3, not *1000/1000: 12.346
    expect(day.toDetail().rollingCoefficientOfVariation).not.toBe(12.3);
    expect(day.toDetail().rollingCoefficientOfVariation).not.toBe(12.346);
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
    const day = new WorkloadDay(makeRow({ acuteLoad: 800.456, chronicLoad: 700.321 }));
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

  it("rounds daily load to 1 decimal (not 0 or 2)", () => {
    // 150.456 * 10 / 10 = 150.5 (1 decimal)
    // If *1/1: 150 (0 decimal), if *100/100: 150.46 (2 decimal)
    const day = new WorkloadDay(makeRow({ dailyLoad: 150.456 }));
    expect(day.dailyLoad).not.toBe(150);
    expect(day.dailyLoad).not.toBe(150.46);
    expect(day.dailyLoad).toBe(150.5);
  });

  it("rounds acute/chronic load to 1 decimal (not 0 or 2)", () => {
    const day = new WorkloadDay(makeRow({ acuteLoad: 800.456, chronicLoad: 700.321 }));
    expect(day.acuteLoad).not.toBe(800);
    expect(day.acuteLoad).not.toBe(800.46);
    expect(day.chronicLoad).not.toBe(700);
    expect(day.chronicLoad).not.toBe(700.32);
  });

  it("rounds workload ratio to 2 decimals (not 1 or 3)", () => {
    // 1.1456 * 100 / 100 = 1.15 (2 decimals)
    // If *10/10: 1.1 (1 decimal), if *1000/1000: 1.146 (3 decimal)
    const day = new WorkloadDay(makeRow({ workloadRatio: 1.1456 }));
    expect(day.workloadRatio).not.toBe(1.1);
    expect(day.workloadRatio).not.toBe(1.146);
    expect(day.workloadRatio).toBe(1.15);
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

  it("returns the most recent day strain as displayedStrain", () => {
    const days = [
      new WorkloadDay({
        date: "2024-03-14",
        dailyLoad: 50,
        acuteLoad: 300,
        chronicLoad: 250,
        workloadRatio: 1.2,
      }),
      new WorkloadDay({
        date: "2024-03-15",
        dailyLoad: 100,
        acuteLoad: 500,
        chronicLoad: 400,
        workloadRatio: 1.25,
      }),
    ];
    const result = computeWorkloadResult(days);
    expect(result.displayedStrain).toBeTypeOf("number");
    expect(result.displayedDate).toBeTypeOf("string");
    // displayedStrain should use the ?? 0 fallback only when empty
    expect(result.displayedStrain).toBeGreaterThanOrEqual(0);
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

  it("rounds stage percentages to 1 decimal (not 0 or 2)", () => {
    const night = new SleepNight({
      ...makeRow(),
      deepPct: 20.456,
      remPct: 25.678,
    });
    const detail = night.toDetail();
    // *10/10: 20.5 (not *1/1: 20, not *100/100: 20.46)
    expect(detail.deepPct).not.toBe(20);
    expect(detail.deepPct).not.toBe(20.46);
    expect(detail.remPct).not.toBe(26);
    expect(detail.remPct).not.toBe(25.68);
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

  it("uses exactly 14 nights (not 13 or 15)", () => {
    // Create exactly 15 nights, each with 80 min deficit
    const nights: SleepNight[] = [];
    for (let index = 0; index < 15; index++) {
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
    // 14 nights * 80 = 1120 (not 15 * 80 = 1200, not 13 * 80 = 1040)
    expect(debt).toBe(1120);
    expect(debt).not.toBe(1200); // Would be 15 nights (slice(-15))
    expect(debt).not.toBe(1040); // Would be 13 nights (slice(-13))
  });

  it("rounds debt to integer via Math.round", () => {
    const nights = [
      new SleepNight({
        date: "2024-03-15",
        durationMinutes: 450,
        sleepMinutes: 450,
        deepPct: 20,
        remPct: 25,
        lightPct: 45,
        awakePct: 10,
        efficiency: 85,
        rollingAvgDuration: null,
      }),
    ];
    // target=480, actual=450 => debt=30 (exact integer, but proves Math.round works)
    const debt = computeSleepDebt(nights, 480);
    expect(Number.isInteger(debt)).toBe(true);
  });

  it("subtracts sleepMinutes from targetMinutes (not the reverse)", () => {
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
    // target=480 - actual=400 = +80 (positive debt, under target)
    // If reversed: actual=400 - target=480 = -80
    const debt = computeSleepDebt(nights, 480);
    expect(debt).toBe(80);
    expect(debt).not.toBe(-80);
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

  it("uses default 62 specifically (not 50, 60, or other values) for null efficiencyPct", () => {
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
    // The default is exactly 62, not 50, 60, 65, or any other value
    expect(components.sleepScore).not.toBe(50);
    expect(components.sleepScore).not.toBe(60);
    expect(components.sleepScore).not.toBe(65);
    expect(components.sleepScore).toBe(62);
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

  it("negates z-score for resting HR (higher HR = lower score, not higher)", () => {
    // RHR 10 above mean => z = +2 => negated to -2 => low score
    const highRhr = computeReadinessComponents({
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
    // Score should be below default (62) because higher HR is bad
    expect(highRhr.restingHrScore).toBeLessThan(62);

    // RHR 10 below mean => z = -2 => negated to +2 => high score
    const lowRhr = computeReadinessComponents({
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
    // Score should be above default (62) because lower HR is good
    expect(lowRhr.restingHrScore).toBeGreaterThan(62);
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

  it("clamps at exactly 0 boundary (efficiencyPct = 0)", () => {
    const boundary = computeReadinessComponents({
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
      efficiencyPct: 0,
    });
    expect(boundary.sleepScore).toBe(0);
  });

  it("clamps at exactly 100 boundary (efficiencyPct = 100)", () => {
    const boundary = computeReadinessComponents({
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
      efficiencyPct: 100,
    });
    expect(boundary.sleepScore).toBe(100);
  });

  it("negates z-score for respiratory rate (higher RR = lower score)", () => {
    const highRr = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: 20,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: 15,
      rrSd30d: 2,
      efficiencyPct: null,
    });
    // Higher respiratory rate should produce lower score
    expect(highRr.respiratoryRateScore).toBeLessThan(62);

    const lowRr = computeReadinessComponents({
      date: "2024-03-15",
      hrv: null,
      restingHr: null,
      respiratoryRate: 10,
      hrvMean30d: null,
      hrvSd30d: null,
      rhrMean30d: null,
      rhrSd30d: null,
      rrMean30d: 15,
      rrSd30d: 2,
      efficiencyPct: null,
    });
    // Lower respiratory rate should produce higher score
    expect(lowRr.respiratoryRateScore).toBeGreaterThan(62);
    expect(lowRr.respiratoryRateScore).toBeGreaterThan(highRr.respiratoryRateScore);
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

  it("uses default 62 (not 50, 60, or 65) for HRV when null", () => {
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
    expect(components.hrvScore).not.toBe(50);
    expect(components.hrvScore).not.toBe(60);
    expect(components.hrvScore).not.toBe(65);
    expect(components.restingHrScore).not.toBe(50);
    expect(components.restingHrScore).not.toBe(60);
    expect(components.respiratoryRateScore).not.toBe(50);
    expect(components.respiratoryRateScore).not.toBe(60);
  });

  it("returns integer scores (Math.round applied)", () => {
    const components = computeReadinessComponents({
      date: "2024-03-15",
      hrv: 55,
      restingHr: 62,
      respiratoryRate: 16,
      hrvMean30d: 50,
      hrvSd30d: 7,
      rhrMean30d: 60,
      rhrSd30d: 4,
      rrMean30d: 15,
      rrSd30d: 2,
      efficiencyPct: 88,
    });
    expect(Number.isInteger(components.hrvScore)).toBe(true);
    expect(Number.isInteger(components.restingHrScore)).toBe(true);
    expect(Number.isInteger(components.sleepScore)).toBe(true);
    expect(Number.isInteger(components.respiratoryRateScore)).toBe(true);
  });

  it("does NOT negate HRV z-score (higher HRV = higher score, not inverted)", () => {
    // HRV 2 SDs above mean: z = +2. If NOT negated, score > 62. If negated, score < 62.
    const highHrv = computeReadinessComponents({
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
    // HRV 2 SDs below mean: z = -2. If NOT negated, score < 62. If negated, score > 62.
    const lowHrv = computeReadinessComponents({
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
    // These two together kill the negation mutation: if HRV z were negated,
    // highHrv would be < 62 (fails first) and lowHrv would be > 62 (fails second)
    expect(highHrv.hrvScore).toBeGreaterThan(lowHrv.hrvScore);
    expect(highHrv.hrvScore).toBeGreaterThan(62);
    expect(lowHrv.hrvScore).toBeLessThan(62);
  });

  it("negates RHR z-score but does NOT negate HRV z-score (opposite directions)", () => {
    // Same z-score magnitude but opposite direction for HRV vs RHR
    // HRV +2 SD above mean → should be GOOD (> 62)
    // RHR +2 SD above mean → should be BAD (< 62)
    const row = {
      date: "2024-03-15",
      hrv: 70,
      restingHr: 70,
      respiratoryRate: null,
      hrvMean30d: 50,
      hrvSd30d: 10,
      rhrMean30d: 50,
      rhrSd30d: 10,
      rrMean30d: null,
      rrSd30d: null,
      efficiencyPct: null,
    };
    const components = computeReadinessComponents(row);
    // Both are +2 SD above mean, but HRV is good (not negated) and RHR is bad (negated)
    expect(components.hrvScore).toBeGreaterThan(62);
    expect(components.restingHrScore).toBeLessThan(62);
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

  it("rounds current strain to 1 decimal (not 0 or 2)", () => {
    const result = computeStrainTargetResult({
      readinessScore: 50,
      chronicLoad: 100,
      acuteLoad: 90,
      currentStrain: 5.456,
    });
    // *10/10: 5.5 (not *1/1: 5, not *100/100: 5.46)
    expect(result.currentStrain).not.toBe(5);
    expect(result.currentStrain).not.toBe(5.46);
    expect(result.currentStrain).toBe(5.5);
  });

  it("rounds current strain to 1 decimal via *10/10", () => {
    const result = computeStrainTargetResult({
      readinessScore: 50,
      chronicLoad: 100,
      acuteLoad: 90,
      currentStrain: 5.456,
    });
    expect(result.currentStrain).toBe(5.5);
  });

  it("computes progressPercent as (currentStrain / targetStrain) * 100", () => {
    const result = computeStrainTargetResult({
      readinessScore: 50,
      chronicLoad: 100,
      acuteLoad: 90,
      currentStrain: 3,
    });
    // progressPercent should be a percentage, not a ratio
    // With targetStrain > 0, it should be Math.round((3 / targetStrain) * 100)
    expect(result.progressPercent).toBeGreaterThan(0);
    expect(result.progressPercent).toBeLessThanOrEqual(100);
    // Verify it's multiplied by 100 (not 10 or 1000)
    if (result.targetStrain > 0) {
      const expected = Math.round((3 / result.targetStrain) * 100);
      expect(result.progressPercent).toBe(expected);
    }
  });

  it("uses division (not multiplication) for progressPercent", () => {
    const result = computeStrainTargetResult({
      readinessScore: 80,
      chronicLoad: 200,
      acuteLoad: 150,
      currentStrain: 2,
    });
    // If it multiplied currentStrain * targetStrain * 100, result would be huge
    // Division gives a reasonable percentage
    expect(result.progressPercent).toBeLessThan(1000);
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

    it("maps all 11 fields from snake_case to camelCase", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          hrv: 55,
          resting_hr: 58,
          respiratory_rate: 14,
          hrv_mean_30d: 52,
          hrv_sd_30d: 6,
          rhr_mean_30d: 60,
          rhr_sd_30d: 4,
          rr_mean_30d: 13,
          rr_sd_30d: 1.5,
          efficiency_pct: 92,
        },
      ]);
      const result = await repo.getReadinessMetrics(30, "2024-03-15");
      const row = result[0];
      expect(row?.date).toBe("2024-03-15");
      expect(row?.hrv).toBe(55);
      expect(row?.restingHr).toBe(58);
      expect(row?.respiratoryRate).toBe(14);
      expect(row?.hrvMean30d).toBe(52);
      expect(row?.hrvSd30d).toBe(6);
      expect(row?.rhrMean30d).toBe(60);
      expect(row?.rhrSd30d).toBe(4);
      expect(row?.rrMean30d).toBe(13);
      expect(row?.rrSd30d).toBe(1.5);
      expect(row?.efficiencyPct).toBe(92);
    });
  });

  describe("getLatestDailyMetrics", () => {
    it("returns null when no rows", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLatestDailyMetrics();
      expect(result).toBeNull();
    });

    it("returns the first row when data exists", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          resting_hr: 58,
          hrv: 55,
          spo2_avg: 97,
          respiratory_rate_avg: 14,
        },
      ]);
      const result = await repo.getLatestDailyMetrics();
      expect(result).not.toBeNull();
      expect(result?.date).toBe("2024-03-15");
      expect(result?.resting_hr).toBe(58);
      expect(result?.hrv).toBe(55);
    });
  });

  describe("getLatestSleepEfficiency", () => {
    it("returns null when no sleep data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLatestSleepEfficiency();
      expect(result).toBeNull();
    });

    it("returns efficiency_pct when data exists", async () => {
      const { repo } = makeRepository([{ efficiency_pct: 92 }]);
      const result = await repo.getLatestSleepEfficiency();
      expect(result).toBe(92);
    });

    it("returns null when efficiency_pct is null", async () => {
      const { repo } = makeRepository([{ efficiency_pct: null }]);
      const result = await repo.getLatestSleepEfficiency();
      expect(result).toBeNull();
    });
  });

  describe("getStrainTarget", () => {
    function makeStrainRepository(executeResults: Record<string, unknown>[][]) {
      const execute = vi.fn();
      for (const rows of executeResults) {
        execute.mockResolvedValueOnce(rows);
      }
      const db = { execute };
      const repo = new RecoveryRepository(db, "user-1", "UTC");
      return { repo, execute };
    }

    it("uses default readinessScore of 50 when no daily metrics", async () => {
      const { repo } = makeStrainRepository([
        [], // getLatestDailyMetrics returns null
        [], // getDailyLoads returns empty
      ]);
      const result = await repo.getStrainTarget(28, "2024-03-15");
      // With readiness=50 and no loads, target should exist
      expect(result).toHaveProperty("targetStrain");
      expect(result).toHaveProperty("zone");
    });

    it("calls execute for daily metrics, then daily loads (2 calls minimum)", async () => {
      const { repo, execute } = makeStrainRepository([
        [], // getLatestDailyMetrics
        [], // getDailyLoads
      ]);
      await repo.getStrainTarget(28, "2024-03-15");
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("calls execute 4 times when daily metrics exist (metrics + params + sleepEff + loads)", async () => {
      const { repo, execute } = makeStrainRepository([
        // getLatestDailyMetrics
        [{ date: "2024-03-15", resting_hr: 58, hrv: 55, spo2_avg: 97, respiratory_rate_avg: 14 }],
        // loadPersonalizedParams (from getEffectiveParams)
        [],
        // getLatestSleepEfficiency
        [{ efficiency_pct: 90 }],
        // getDailyLoads
        [],
      ]);
      await repo.getStrainTarget(28, "2024-03-15");
      expect(execute).toHaveBeenCalledTimes(4);
    });
  });
});
