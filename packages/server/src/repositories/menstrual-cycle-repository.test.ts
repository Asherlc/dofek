import { describe, expect, it, vi } from "vitest";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

describe("MenstrualCycleRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new MenstrualCycleRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("getCurrentPhase", () => {
    it("returns nulls when no period data exists", async () => {
      const { repo } = makeRepository([]);

      const result = await repo.getCurrentPhase();

      expect(result).toEqual({ phase: null, dayOfCycle: null, cycleLength: null });
    });

    it("computes menstrual phase for day 1 of cycle", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "28" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("menstrual");
      expect(result.dayOfCycle).toBe(1);
      expect(result.cycleLength).toBe(28);
    });

    it("computes follicular phase for day 8 of 28-day cycle", async () => {
      const today = new Date("2025-01-22T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "28" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("follicular");
      expect(result.dayOfCycle).toBe(8);
    });

    it("computes ovulatory phase around ovulation day", async () => {
      // Ovulation for 28-day cycle: day 14 (28-14=14), window is 13-15
      const today = new Date("2025-01-28T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "28" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("ovulatory");
      expect(result.dayOfCycle).toBe(14);
    });

    it("computes luteal phase after ovulatory window", async () => {
      // Day 20 of 28-day cycle is luteal
      const today = new Date("2025-02-03T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "28" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("luteal");
      expect(result.dayOfCycle).toBe(20);
    });

    it("uses default 28-day cycle when no average available", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: null }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.cycleLength).toBe(28);
      expect(result.phase).toBe("menstrual");
    });

    it("returns null phase when past cycle length + 7 days", async () => {
      // Day 40 of a 28-day cycle (40 > 28+7=35)
      const today = new Date("2025-02-23T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "28" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBeNull();
      expect(result.dayOfCycle).toBeNull();
      expect(result.cycleLength).toBe(28);
    });

    it("rounds average cycle length to nearest integer", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([{ start_date: "2025-01-15", avg_cycle_length: "29.7" }]);

      const result = await repo.getCurrentPhase(today);

      expect(result.cycleLength).toBe(30);
    });

    it("handles Date objects from postgres driver", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([
        { start_date: new Date("2025-01-15"), avg_cycle_length: "28" },
      ]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("menstrual");
      expect(result.dayOfCycle).toBe(1);
    });
  });

  describe("logPeriod", () => {
    it("returns the inserted period with camelCase fields", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: "2025-01-15",
          end_date: "2025-01-19",
          notes: "Light flow",
        },
      ]);

      const result = await repo.logPeriod("2025-01-15", "2025-01-19", "Light flow");

      expect(result).toEqual({
        id: "period-1",
        startDate: "2025-01-15",
        endDate: "2025-01-19",
        notes: "Light flow",
      });
    });

    it("returns null when insert returns no rows", async () => {
      const { repo } = makeRepository([]);

      const result = await repo.logPeriod("2025-01-15", null, null);

      expect(result).toBeNull();
    });

    it("handles null end date and notes", async () => {
      const { repo } = makeRepository([
        {
          id: "period-2",
          start_date: "2025-01-15",
          end_date: null,
          notes: null,
        },
      ]);

      const result = await repo.logPeriod("2025-01-15", null, null);

      expect(result).toEqual({
        id: "period-2",
        startDate: "2025-01-15",
        endDate: null,
        notes: null,
      });
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([
        { id: "period-1", start_date: "2025-01-15", end_date: null, notes: null },
      ]);

      await repo.logPeriod("2025-01-15", null, null);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getHistory", () => {
    it("returns empty array when no periods exist", async () => {
      const { repo } = makeRepository([]);

      const result = await repo.getHistory(6);

      expect(result).toEqual([]);
    });

    it("maps DB rows to MenstrualPeriod objects", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: "2025-01-01",
          end_date: "2025-01-05",
          notes: "Normal flow",
        },
        {
          id: "period-2",
          start_date: "2025-01-29",
          end_date: null,
          notes: null,
        },
      ]);

      const result = await repo.getHistory(6);

      expect(result).toEqual([
        {
          id: "period-1",
          startDate: "2025-01-01",
          endDate: "2025-01-05",
          notes: "Normal flow",
        },
        {
          id: "period-2",
          startDate: "2025-01-29",
          endDate: null,
          notes: null,
        },
      ]);
    });

    it("handles Date objects from postgres driver", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: new Date("2025-01-01"),
          end_date: new Date("2025-01-05"),
          notes: "Normal",
        },
      ]);

      const result = await repo.getHistory(6);

      expect(result[0]?.startDate).toBe("2025-01-01");
      expect(result[0]?.endDate).toBe("2025-01-05");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getHistory(12);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
