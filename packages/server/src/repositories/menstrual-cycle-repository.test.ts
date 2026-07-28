import { describe, expect, it, vi } from "vitest";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

describe("MenstrualCycleRepository", () => {
  function phaseRow({
    startDate = "2025-01-15",
    averageCycleLength = "28",
    completedCycleCount = 3,
    minimumCycleLength = 27,
    maximumCycleLength = 29,
  }: {
    startDate?: string | Date;
    averageCycleLength?: string | null;
    completedCycleCount?: number;
    minimumCycleLength?: number | null;
    maximumCycleLength?: number | null;
  } = {}) {
    return {
      start_date: startDate,
      avg_cycle_length: averageCycleLength,
      completed_cycle_count: completedCycleCount,
      min_cycle_length: minimumCycleLength,
      max_cycle_length: maximumCycleLength,
    };
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new MenstrualCycleRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("getCurrentPhase", () => {
    it("returns nulls when no period data exists", async () => {
      const { repo } = makeRepository([]);

      const result = await repo.getCurrentPhase();

      expect(result).toEqual({
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
      });
    });

    it("computes menstrual phase for day 1 of cycle", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([phaseRow()]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("menstrual");
      expect(result.dayOfCycle).toBe(1);
      expect(result.cycleLength).toBe(28);
    });

    it("computes follicular phase for day 8 of 28-day cycle", async () => {
      const today = new Date("2025-01-22T12:00:00Z");
      const { repo } = makeRepository([phaseRow()]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("follicular");
      expect(result.dayOfCycle).toBe(8);
    });

    it("computes ovulatory phase around ovulation day", async () => {
      // Ovulation for 28-day cycle: day 14 (28-14=14), window is 13-15
      const today = new Date("2025-01-28T12:00:00Z");
      const { repo } = makeRepository([phaseRow()]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("ovulatory");
      expect(result.dayOfCycle).toBe(14);
    });

    it("computes luteal phase after ovulatory window", async () => {
      // Day 20 of 28-day cycle is luteal
      const today = new Date("2025-02-03T12:00:00Z");
      const { repo } = makeRepository([phaseRow()]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("luteal");
      expect(result.dayOfCycle).toBe(20);
    });

    it("uses default 28-day cycle when no average available", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([
        phaseRow({
          averageCycleLength: null,
          completedCycleCount: 0,
          minimumCycleLength: null,
          maximumCycleLength: null,
        }),
      ]);

      const result = await repo.getCurrentPhase(today);

      expect(result.cycleLength).toBe(28);
      expect(result.phase).toBe("menstrual");
      expect(result.estimate).toEqual({
        basis: "generic-28-day-default",
        completedCycleCount: 0,
        observedCycleLengthRange: null,
        phaseLabel: "Estimated Menstrual phase",
        cycleDayLabel: "Day 1 of an estimated 28-day cycle",
        dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
        methodLabel:
          "Phase and cycle length use a generic 28-day default based on 0 completed cycles; this is not a personal prediction.",
        uncertaintyLabel: "No personal cycle-length range is available yet.",
        limitationLabel: "No calibrated confidence score or next-period forecast is available.",
      });
    });

    it("explains the personal history and observed range behind an estimate", async () => {
      const today = new Date("2025-01-27T12:00:00Z");
      const { repo } = makeRepository([
        phaseRow({
          averageCycleLength: "29",
          completedCycleCount: 4,
          minimumCycleLength: 27,
          maximumCycleLength: 31,
        }),
      ]);

      const result = await repo.getCurrentPhase(today);

      expect(result).toEqual({
        phase: "follicular",
        dayOfCycle: 13,
        cycleLength: 29,
        estimate: {
          basis: "personal-cycle-average",
          completedCycleCount: 4,
          observedCycleLengthRange: {
            minimumDays: 27,
            maximumDays: 31,
          },
          phaseLabel: "Estimated Follicular phase",
          cycleDayLabel: "Day 13 of an estimated 29-day cycle",
          dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
          methodLabel: "Phase and cycle length use the average of 4 completed cycles.",
          uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 31 days.",
          limitationLabel: "No calibrated confidence score or next-period forecast is available.",
        },
      });
    });

    it("describes a single completed cycle without presenting a range", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([
        phaseRow({
          completedCycleCount: 1,
          minimumCycleLength: 28,
          maximumCycleLength: 28,
        }),
      ]);

      const result = await repo.getCurrentPhase(today);

      expect(result.estimate?.methodLabel).toBe(
        "Phase and cycle length use the average of 1 completed cycle.",
      );
      expect(result.estimate?.uncertaintyLabel).toBe("The recorded cycle length was 28 days.");
    });

    it("returns null phase when past cycle length + 7 days", async () => {
      // Day 40 of a 28-day cycle (40 > 28+7=35)
      const today = new Date("2025-02-23T12:00:00Z");
      const { repo } = makeRepository([phaseRow()]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBeNull();
      expect(result.dayOfCycle).toBeNull();
      expect(result.cycleLength).toBe(28);
      expect(result.estimate).toBeNull();
    });

    it("rounds average cycle length to nearest integer", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([phaseRow({ averageCycleLength: "29.7" })]);

      const result = await repo.getCurrentPhase(today);

      expect(result.cycleLength).toBe(30);
    });

    it("handles Date objects from postgres driver", async () => {
      const today = new Date("2025-01-15T12:00:00Z");
      const { repo } = makeRepository([phaseRow({ startDate: new Date("2025-01-15") })]);

      const result = await repo.getCurrentPhase(today);

      expect(result.phase).toBe("menstrual");
      expect(result.dayOfCycle).toBe(1);
    });
  });

  describe("logPeriod", () => {
    it("rejects an end date before the start date without writing", async () => {
      const { repo, execute } = makeRepository();

      await expect(repo.logPeriod("2025-01-15", "2025-01-14", null)).rejects.toThrow(
        "Period end date cannot be before start date.",
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("returns the inserted period with camelCase fields", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: "2025-01-15",
          end_date: "2025-01-19",
          duration_days: 5,
          notes: "Light flow",
        },
      ]);

      const result = await repo.logPeriod("2025-01-15", "2025-01-19", "Light flow");

      expect(result).toEqual({
        id: "period-1",
        startDate: "2025-01-15",
        endDate: "2025-01-19",
        durationDays: 5,
        durationLabel: "5 days",
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
          duration_days: null,
          notes: null,
        },
      ]);

      const result = await repo.logPeriod("2025-01-15", null, null);

      expect(result).toEqual({
        id: "period-2",
        startDate: "2025-01-15",
        endDate: null,
        durationDays: null,
        durationLabel: null,
        notes: null,
      });
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "period-1",
          start_date: "2025-01-15",
          end_date: null,
          duration_days: null,
          notes: null,
        },
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
          duration_days: 5,
          notes: "Normal flow",
        },
        {
          id: "period-2",
          start_date: "2025-01-29",
          end_date: null,
          duration_days: null,
          notes: null,
        },
      ]);

      const result = await repo.getHistory(6);

      expect(result).toEqual([
        {
          id: "period-1",
          startDate: "2025-01-01",
          endDate: "2025-01-05",
          durationDays: 5,
          durationLabel: "5 days",
          notes: "Normal flow",
        },
        {
          id: "period-2",
          startDate: "2025-01-29",
          endDate: null,
          durationDays: null,
          durationLabel: null,
          notes: null,
        },
      ]);
    });

    it("uses singular display text for a one-day period", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: "2025-01-15",
          end_date: "2025-01-15",
          duration_days: 1,
          notes: null,
        },
      ]);

      const result = await repo.getHistory(6);

      expect(result[0]).toEqual({
        id: "period-1",
        startDate: "2025-01-15",
        endDate: "2025-01-15",
        durationDays: 1,
        durationLabel: "1 day",
        notes: null,
      });
    });

    it("handles Date objects from postgres driver", async () => {
      const { repo } = makeRepository([
        {
          id: "period-1",
          start_date: new Date("2025-01-01"),
          end_date: new Date("2025-01-05"),
          duration_days: 5,
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
