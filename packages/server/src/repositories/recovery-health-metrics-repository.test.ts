import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchRhr: vi.fn() }));

vi.mock("./resting-heart-rate-query.ts", () => ({
  fetchRestingHeartRateValuesCte: mocks.fetchRhr,
}));

import { RecoveryHealthMetricsRepository } from "./recovery-health-metrics-repository.ts";

describe("RecoveryHealthMetricsRepository", () => {
  it("supplies the deduplicated resting-HR values CTE to the daily metrics query", async () => {
    const restingHeartRateCte = sql`VALUES ('2026-06-01', 48)`;
    mocks.fetchRhr.mockResolvedValueOnce(restingHeartRateCte);
    const listRange = vi.fn().mockResolvedValue([{ date: "2026-06-01", resting_hr: 48 }]);
    const sensorStore = { query: vi.fn() };
    const repository = new RecoveryHealthMetricsRepository(
      { listRange },
      sensorStore,
      "user-1",
      "America/Los_Angeles",
    );

    await repository.listRange("2026-06-01", "2026-06-03");

    expect(mocks.fetchRhr).toHaveBeenCalledWith({
      sensorStore,
      userId: "user-1",
      timezone: "America/Los_Angeles",
      endDate: "2026-06-03",
      days: 3,
    });
    expect(listRange).toHaveBeenCalledWith("2026-06-01", "2026-06-03", restingHeartRateCte);
  });
});
