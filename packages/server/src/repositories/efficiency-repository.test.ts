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
    expect(week?.polarizationIndex).toBe(
      computePolarizationIndex(5000, 1000, 500),
    );
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
    expect(result.weeks[0]?.polarizationIndex).toBe(
      computePolarizationIndex(0, 0, 0),
    );
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
});
