import { describe, expect, it } from "vitest";
import { DerivedCardioRepository } from "./derived-cardio-repository.ts";

function makeDb(rows: Record<string, unknown>[]) {
  return {
    execute: async () => rows,
  };
}

describe("DerivedCardioRepository", () => {
  it("averages all qualifying VO2 max estimates returned by the query", async () => {
    const repo = new DerivedCardioRepository(makeDb([{ vo2max: "40" }, { vo2max: "50" }]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    const result = await repo.getVo2MaxAverage("2026-04-28", 90);

    expect(result?.value).toBe(45);
    expect(result?.sampleCount).toBe(2);
  });

  it("returns null when no VO2 max estimates qualify", async () => {
    const repo = new DerivedCardioRepository(makeDb([]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(repo.getVo2MaxAverage("2026-04-28", 90)).resolves.toBeNull();
  });

  it("maps resting HR rows from SQL", async () => {
    const repo = new DerivedCardioRepository(makeDb([{ date: "2026-04-27", resting_hr: "52" }]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(repo.getDailyRestingHeartRates("2026-04-28", 7)).resolves.toEqual([
      { date: "2026-04-27", restingHr: 52 },
    ]);
  });
});
