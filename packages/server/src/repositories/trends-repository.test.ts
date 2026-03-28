import { describe, expect, it, vi } from "vitest";
import { roundOrNull, TrendRow, TrendsRepository } from "./trends-repository.ts";

// ---------------------------------------------------------------------------
// roundOrNull
// ---------------------------------------------------------------------------

describe("roundOrNull", () => {
  it("returns null for null input", () => {
    expect(roundOrNull(null, 1)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(roundOrNull(undefined, 2)).toBeNull();
  });

  it("rounds to 1 decimal place", () => {
    expect(roundOrNull(72.456, 1)).toBe(72.5);
  });

  it("rounds to 2 decimal places", () => {
    expect(roundOrNull(5.6789, 2)).toBe(5.68);
  });

  it("handles string-coercible numbers", () => {
    expect(roundOrNull("150.789", 1)).toBe(150.8);
  });

  it("returns 0 for zero input", () => {
    expect(roundOrNull(0, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TrendRow
// ---------------------------------------------------------------------------

describe("TrendRow", () => {
  function makeRow(
    overrides: Partial<
      Parameters<typeof TrendRow.prototype.toDetail> extends never[]
        ? ReturnType<typeof makeTrendData>
        : ReturnType<typeof makeTrendData>
    > = {},
  ) {
    return makeTrendData(overrides);
  }

  function makeTrendData(overrides: Record<string, unknown> = {}) {
    return {
      period: "2024-06-15",
      avgHr: 142.567,
      maxHr: 185,
      avgPower: 210.345,
      maxPower: 380,
      avgCadence: 88.1234,
      avgSpeed: 28.5678,
      totalSamples: 3600,
      hrSamples: 3500,
      powerSamples: 3400,
      activityCount: 2,
      ...overrides,
    };
  }

  it("exposes period getter", () => {
    const row = new TrendRow(makeRow());
    expect(row.period).toBe("2024-06-15");
  });

  it("exposes avgHr getter", () => {
    const row = new TrendRow(makeRow({ avgHr: 155.3 }));
    expect(row.avgHr).toBe(155.3);
  });

  it("exposes activityCount getter", () => {
    const row = new TrendRow(makeRow({ activityCount: 5 }));
    expect(row.activityCount).toBe(5);
  });

  it("handles null avgHr", () => {
    const row = new TrendRow(makeRow({ avgHr: null }));
    expect(row.avgHr).toBeNull();
  });

  describe("toDetail()", () => {
    it("rounds avgHr to 1 decimal", () => {
      const detail = new TrendRow(makeRow({ avgHr: 142.567 })).toDetail();
      expect(detail.avgHr).toBe(142.6);
    });

    it("returns maxHr as number when present", () => {
      const detail = new TrendRow(makeRow({ maxHr: 185 })).toDetail();
      expect(detail.maxHr).toBe(185);
    });

    it("returns null maxHr when absent", () => {
      const detail = new TrendRow(makeRow({ maxHr: null })).toDetail();
      expect(detail.maxHr).toBeNull();
    });

    it("rounds avgPower to 1 decimal", () => {
      const detail = new TrendRow(makeRow({ avgPower: 210.345 })).toDetail();
      expect(detail.avgPower).toBe(210.3);
    });

    it("returns null avgPower when absent", () => {
      const detail = new TrendRow(makeRow({ avgPower: null })).toDetail();
      expect(detail.avgPower).toBeNull();
    });

    it("returns maxPower as number when present", () => {
      const detail = new TrendRow(makeRow({ maxPower: 380 })).toDetail();
      expect(detail.maxPower).toBe(380);
    });

    it("returns null maxPower when absent", () => {
      const detail = new TrendRow(makeRow({ maxPower: null })).toDetail();
      expect(detail.maxPower).toBeNull();
    });

    it("rounds avgCadence to 1 decimal", () => {
      const detail = new TrendRow(makeRow({ avgCadence: 88.1234 })).toDetail();
      expect(detail.avgCadence).toBe(88.1);
    });

    it("rounds avgSpeed to 2 decimals", () => {
      const detail = new TrendRow(makeRow({ avgSpeed: 28.5678 })).toDetail();
      expect(detail.avgSpeed).toBe(28.57);
    });

    it("converts totalSamples/hrSamples/powerSamples/activityCount to numbers", () => {
      const detail = new TrendRow(
        makeRow({
          totalSamples: 3600,
          hrSamples: 3500,
          powerSamples: 3400,
          activityCount: 2,
        }),
      ).toDetail();
      expect(detail.totalSamples).toBe(3600);
      expect(detail.hrSamples).toBe(3500);
      expect(detail.powerSamples).toBe(3400);
      expect(detail.activityCount).toBe(2);
    });

    it("handles all null optional fields", () => {
      const detail = new TrendRow(
        makeRow({
          avgHr: null,
          maxHr: null,
          avgPower: null,
          maxPower: null,
          avgCadence: null,
          avgSpeed: null,
        }),
      ).toDetail();
      expect(detail.avgHr).toBeNull();
      expect(detail.maxHr).toBeNull();
      expect(detail.avgPower).toBeNull();
      expect(detail.maxPower).toBeNull();
      expect(detail.avgCadence).toBeNull();
      expect(detail.avgSpeed).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// TrendsRepository
// ---------------------------------------------------------------------------

describe("TrendsRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new TrendsRepository({ execute }, "user-1");
    return { repo, execute };
  }

  const sampleDbRow = {
    period: "2024-06-15",
    avg_hr: "142.5",
    max_hr: "185",
    avg_power: "210.3",
    max_power: "380",
    avg_cadence: "88.1",
    avg_speed: "28.57",
    total_samples: "3600",
    hr_samples: "3500",
    power_samples: "3400",
    activity_count: "2",
  };

  describe("getDaily", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getDaily(365)).toEqual([]);
    });

    it("returns TrendRow instances", async () => {
      const { repo } = makeRepository([sampleDbRow]);
      const result = await repo.getDaily(365);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(TrendRow);
      expect(result[0]?.period).toBe("2024-06-15");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getDaily(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getWeekly", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getWeekly(52)).toEqual([]);
    });

    it("returns TrendRow instances", async () => {
      const { repo } = makeRepository([sampleDbRow]);
      const result = await repo.getWeekly(52);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(TrendRow);
      expect(result[0]?.period).toBe("2024-06-15");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getWeekly(12);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
