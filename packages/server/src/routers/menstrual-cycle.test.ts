import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const mockInvalidateUserQueryDomains = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { menstrualCycleRouter } from "./menstrual-cycle.ts";

const createCaller = createTestCallerFactory(menstrualCycleRouter);

describe("menstrualCycleRouter", () => {
  beforeEach(() => {
    mockInvalidateUserQueryDomains.mockClear();
  });

  describe("currentPhase", () => {
    it("returns null phase when no periods logged", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.currentPhase();

      expect(result.phase).toBeNull();
      expect(result.dayOfCycle).toBeNull();
      expect(result.estimate).toBeNull();
      expect(result.availability.status).toBe("no-history");
    });

    it("computes current phase from most recent period", async () => {
      // Most recent period started 10 days ago, avg cycle = 28
      const rows = [
        {
          start_date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
          avg_cycle_length: 28,
          completed_cycle_count: 3,
          min_cycle_length: 27,
          max_cycle_length: 29,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.currentPhase();

      expect(result.phase).not.toBeNull();
      expect(result.dayOfCycle).toBe(11); // day 1 is start day, day 11 is 10 days later
      expect(result.cycleLength).toBe(28);
      expect(result.estimate).toMatchObject({
        basis: "personal-cycle-average",
        completedCycleCount: 3,
        observedCycleLengthRange: {
          minimumDays: 27,
          maximumDays: 29,
        },
      });
    });
  });

  describe("history", () => {
    it("returns empty history when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.history({ months: 6 });

      expect(result).toEqual([]);
    });

    it("returns period history from SQL results", async () => {
      const rows = [
        {
          id: "p1",
          start_date: "2026-01-15",
          end_date: "2026-01-20",
          duration_days: 6,
          notes: null,
        },
        {
          id: "p2",
          start_date: "2026-02-12",
          end_date: "2026-02-17",
          duration_days: 6,
          notes: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.history({ months: 6 });

      expect(result).toHaveLength(2);
      expect(result[0]?.startDate).toBe("2026-01-15");
      expect(result[0]?.durationDays).toBe(6);
      expect(result[0]?.durationLabel).toBe("6 days");
      expect(result[1]?.startDate).toBe("2026-02-12");
    });

    it("uses default months (6) when not specified", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.history({});
      expect(result).toEqual([]);
    });

    it("rejects months below 1", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      await expect(caller.history({ months: 0 })).rejects.toThrow();
    });

    it("rejects months above 24", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      await expect(caller.history({ months: 25 })).rejects.toThrow();
    });
  });

  describe("logPeriod", () => {
    it("rejects an end date before the start date without writing", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await expect(
        caller.logPeriod({ startDate: "2026-03-02", endDate: "2026-03-01" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Period end date cannot be before start date."),
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it("allows a period to start and end on the same date", async () => {
      const insertedRow = {
        id: "same-day-id",
        start_date: "2026-03-01",
        end_date: "2026-03-01",
        duration_days: 1,
        notes: null,
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });

      const result = await caller.logPeriod({
        startDate: "2026-03-01",
        endDate: "2026-03-01",
      });

      expect(result?.durationDays).toBe(1);
      expect(result?.durationLabel).toBe("1 day");
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["menstrualCycle"]);
    });

    it("logs a new period start", async () => {
      const insertedRow = {
        id: "new-id",
        start_date: "2026-03-01",
        end_date: null,
        duration_days: null,
        notes: null,
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });
      const result = await caller.logPeriod({ startDate: "2026-03-01" });

      expect(result?.id).toBe("new-id");
      expect(result?.startDate).toBe("2026-03-01");
      expect(result?.durationDays).toBeNull();
      expect(result?.durationLabel).toBeNull();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["menstrualCycle"]);
    });

    it("does not invalidate when no period is written", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logPeriod({ startDate: "2026-03-01" });

      expect(result).toBeNull();
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });
  });

  describe("updatePeriod", () => {
    const periodId = "11111111-1111-4111-8111-111111111111";

    it("corrects a period and invalidates cycle queries", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          id: periodId,
          start_date: "2026-03-02",
          end_date: "2026-03-05",
          duration_days: 4,
          notes: "Corrected date",
        },
      ]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.updatePeriod({
        id: periodId,
        startDate: "2026-03-02",
        endDate: "2026-03-05",
        notes: "Corrected date",
      });

      expect(result).toMatchObject({
        id: periodId,
        startDate: "2026-03-02",
        durationLabel: "4 days",
      });
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["menstrualCycle"]);
    });

    it("rejects an end date before the corrected start date without writing", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(
        caller.updatePeriod({
          id: periodId,
          startDate: "2026-03-02",
          endDate: "2026-03-01",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Period end date cannot be before start date."),
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it("returns an actionable not-found error for a period outside the user scope", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await expect(
        caller.updatePeriod({ id: periodId, startDate: "2026-03-02" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Period entry was not found. Refresh the history and try again.",
      });
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });

    it("returns an actionable conflict when the corrected start date already exists", async () => {
      const uniqueViolation = new Error("Failed query", {
        cause: Object.assign(new Error("duplicate key value"), { code: "23505" }),
      });
      const caller = createCaller({
        db: { execute: vi.fn().mockRejectedValue(uniqueViolation) },
        userId: "user-1",
      });

      await expect(
        caller.updatePeriod({ id: periodId, startDate: "2026-03-08" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "A period is already recorded for 2026-03-08. Choose a different start date.",
      });
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });
  });

  describe("deletePeriod", () => {
    const periodId = "22222222-2222-4222-8222-222222222222";

    it("deletes a period and invalidates cycle queries", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([{ id: periodId }]) },
        userId: "user-1",
      });

      await expect(caller.deletePeriod({ id: periodId })).resolves.toEqual({ deleted: true });
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["menstrualCycle"]);
    });

    it("returns an actionable not-found error for a period outside the user scope", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await expect(caller.deletePeriod({ id: periodId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Period entry was not found. Refresh the history and try again.",
      });
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });
  });
});
