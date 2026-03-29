import { computePolarizationIndex } from "@dofek/zones/zones";
import { describe, expect, it, vi } from "vitest";
import { EfficiencyRepository } from "./efficiency-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
  return { repo, execute };
}

// ---------------------------------------------------------------------------
// getAerobicEfficiency
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency", () => {
  it("returns null maxHr and empty activities when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getAerobicEfficiency(180);
    expect(result).toEqual({ maxHr: null, activities: [] });
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getAerobicEfficiency(90);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps rows to AerobicEfficiencyActivity objects", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "190",
        date: "2025-06-01",
        activity_type: "cycling",
        name: "Morning Ride",
        avg_power_z2: "180.5",
        avg_hr_z2: "135.2",
        efficiency_factor: "1.335",
        z2_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicEfficiency(180);

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
        activity_type: "cycling",
        name: "Ride",
        avg_power_z2: "180.5",
        avg_hr_z2: "135.2",
        efficiency_factor: "1.335",
        z2_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicEfficiency(180);
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
        activity_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "400",
      },
    ]);
    const result = await repo.getAerobicEfficiency(180);
    expect(result.maxHr).toBe(192);
    expect(result.maxHr).not.toBeNull();
  });

  it("extracts maxHr from first row", async () => {
    const { repo } = makeRepository([
      {
        max_hr: "185",
        date: "2025-06-01",
        activity_type: "running",
        name: "Easy Run",
        avg_power_z2: "250",
        avg_hr_z2: "140",
        efficiency_factor: "1.786",
        z2_samples: "600",
      },
      {
        max_hr: "185",
        date: "2025-06-02",
        activity_type: "cycling",
        name: "Zone 2 Ride",
        avg_power_z2: "175",
        avg_hr_z2: "130",
        efficiency_factor: "1.346",
        z2_samples: "3600",
      },
    ]);
    const result = await repo.getAerobicEfficiency(180);
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
    const result = await repo.getAerobicDecoupling(180);
    expect(result).toEqual([]);
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getAerobicDecoupling(90);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps rows to AerobicDecouplingActivity objects", async () => {
    const { repo } = makeRepository([
      {
        date: "2025-06-01",
        activity_type: "cycling",
        name: "Long Ride",
        first_half_ratio: "1.350",
        second_half_ratio: "1.280",
        decoupling_pct: "5.19",
        total_samples: "7200",
      },
    ]);
    const result = await repo.getAerobicDecoupling(180);

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
        activity_type: "cycling",
        name: "Ride A",
        first_half_ratio: "1.400",
        second_half_ratio: "1.350",
        decoupling_pct: "3.57",
        total_samples: "3600",
      },
      {
        date: "2025-06-03",
        activity_type: "running",
        name: "Run B",
        first_half_ratio: "1.200",
        second_half_ratio: "1.100",
        decoupling_pct: "8.33",
        total_samples: "1800",
      },
    ]);
    const result = await repo.getAerobicDecoupling(180);
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
    const result = await repo.getPolarizationTrend(180);
    expect(result).toEqual({ maxHr: null, weeks: [] });
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getPolarizationTrend(90);
    expect(execute).toHaveBeenCalledTimes(1);
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
    const result = await repo.getPolarizationTrend(180);
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
    const result = await repo.getPolarizationTrend(180);

    expect(result.maxHr).toBe(190);
    expect(result.weeks).toHaveLength(1);

    const week = result.weeks[0];
    expect(week?.week).toBe("2025-05-26");
    expect(week?.z1Seconds).toBe(5000);
    expect(week?.z2Seconds).toBe(1000);
    expect(week?.z3Seconds).toBe(500);
    // Verify polarization index matches the shared function
    expect(week?.polarizationIndex).toBe(computePolarizationIndex(5000, 1000, 500));
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
    const result = await repo.getPolarizationTrend(180);
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
    const result = await repo.getPolarizationTrend(180);
    expect(result.maxHr).toBe(185);
    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0]?.week).toBe("2025-05-19");
    expect(result.weeks[1]?.week).toBe("2025-05-26");
  });

  it("returns null maxHr when rows is empty (rows.length > 0 boundary)", async () => {
    // Specifically verifies that `rows.length > 0` is the condition, not `rows.length >= 0`
    // With 0 rows: maxHr must be null
    const { repo: emptyRepo } = makeRepository([]);
    const emptyResult = await emptyRepo.getPolarizationTrend(180);
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
    const oneRowResult = await oneRowRepo.getPolarizationTrend(180);
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
    const result = await repo.getPolarizationTrend(180);
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
    const executeEmpty = vi.fn().mockResolvedValue([]);
    const repoEmpty = new EfficiencyRepository({ execute: executeEmpty }, "user-1", "UTC");
    const emptyResult = await repoEmpty.getAerobicEfficiency(180);
    expect(emptyResult.maxHr).toBeNull();

    // 1 row => Number(rows[0].max_hr)
    const executeOne = vi.fn().mockResolvedValue([
      {
        max_hr: "200",
        date: "2025-06-01",
        activity_type: "cycling",
        name: "Ride",
        avg_power_z2: "180",
        avg_hr_z2: "135",
        efficiency_factor: "1.333",
        z2_samples: "500",
      },
    ]);
    const repoOne = new EfficiencyRepository({ execute: executeOne }, "user-1", "UTC");
    const oneResult = await repoOne.getAerobicEfficiency(180);
    expect(oneResult.maxHr).toBe(200);
    expect(oneResult.maxHr).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAerobicEfficiency — String() conversions in map
// ---------------------------------------------------------------------------

describe("EfficiencyRepository.getAerobicEfficiency (String conversions)", () => {
  it("uses String() for date, activityType, and name fields", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        max_hr: "190",
        date: "2025-07-01",
        activity_type: "running",
        name: "Tempo Run",
        avg_power_z2: "200",
        avg_hr_z2: "140",
        efficiency_factor: "1.429",
        z2_samples: "500",
      },
    ]);
    const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
    const result = await repo.getAerobicEfficiency(180);
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
    const execute = vi.fn().mockResolvedValue([
      {
        date: "2025-07-01",
        activity_type: "running",
        name: "Easy Run",
        first_half_ratio: "1.250",
        second_half_ratio: "1.200",
        decoupling_pct: "4.00",
        total_samples: "2400",
      },
    ]);
    const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
    const result = await repo.getAerobicDecoupling(180);
    const activity = result[0];
    expect(typeof activity?.date).toBe("string");
    expect(typeof activity?.activityType).toBe("string");
    expect(typeof activity?.name).toBe("string");
    expect(activity?.date).toBe("2025-07-01");
    expect(activity?.activityType).toBe("running");
    expect(activity?.name).toBe("Easy Run");
  });

  it("converts numeric string fields to numbers", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        date: "2025-07-01",
        activity_type: "cycling",
        name: "Ride",
        first_half_ratio: "1.333",
        second_half_ratio: "1.222",
        decoupling_pct: "8.33",
        total_samples: "5000",
      },
    ]);
    const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
    const result = await repo.getAerobicDecoupling(180);
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
    const execute = vi.fn().mockResolvedValue([
      {
        max_hr: "190",
        week: "2025-06-02",
        z1_seconds: "3600",
        z2_seconds: "1200",
        z3_seconds: "600",
      },
    ]);
    const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
    const result = await repo.getPolarizationTrend(180);
    expect(typeof result.weeks[0]?.week).toBe("string");
    expect(result.weeks[0]?.week).toBe("2025-06-02");
  });

  it("uses Number() for maxHr from first row", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        max_hr: "193",
        week: "2025-06-02",
        z1_seconds: "100",
        z2_seconds: "100",
        z3_seconds: "100",
      },
    ]);
    const repo = new EfficiencyRepository({ execute }, "user-1", "UTC");
    const result = await repo.getPolarizationTrend(180);
    expect(typeof result.maxHr).toBe("number");
    expect(result.maxHr).toBe(193);
  });
});
