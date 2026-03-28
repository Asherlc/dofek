import { describe, expect, it, vi } from "vitest";
import { InsightsRepository } from "./insights-repository.ts";

vi.mock("../insights/engine.ts", () => ({
  computeInsights: vi.fn().mockReturnValue([]),
}));

function makeDb() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([]) // metrics
    .mockResolvedValueOnce([]) // sleep
    .mockResolvedValueOnce([]) // activities
    .mockResolvedValueOnce([]) // nutrition
    .mockResolvedValueOnce([]); // bodyComp
  return { execute };
}

describe("InsightsRepository", () => {
  describe("computeInsights", () => {
    it("executes 5 queries (one per dataset)", async () => {
      const db = makeDb();
      const repo = new InsightsRepository(db, "user-1");
      await repo.computeInsights(90, "2024-06-01");
      expect(db.execute).toHaveBeenCalledTimes(5);
    });

    it("returns engine result for empty data", async () => {
      const db = makeDb();
      const repo = new InsightsRepository(db, "user-1");
      const result = await repo.computeInsights(90, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("passes parsed rows to computeInsights engine", async () => {
      const { computeInsights } = await import("../insights/engine.ts");
      const db = makeDb();
      const repo = new InsightsRepository(db, "user-1");
      await repo.computeInsights(30, "2024-06-01");
      expect(computeInsights).toHaveBeenCalledWith([], [], [], [], []);
    });
  });
});
