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

import { breathworkRouter } from "./breathwork.ts";

const createCaller = createTestCallerFactory(breathworkRouter);

describe("breathworkRouter", () => {
  beforeEach(() => {
    mockInvalidateUserQueryDomains.mockClear();
  });

  describe("techniques", () => {
    it("returns all available techniques", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });
      const result = await caller.techniques();

      expect(result.length).toBeGreaterThanOrEqual(3);
      for (const technique of result) {
        expect(technique.id).toBeTruthy();
        expect(technique.name).toBeTruthy();
        expect(technique.purpose).toBeTruthy();
        expect(technique.difficulty).toMatch(/^(Beginner|Intermediate|Advanced)$/);
        expect(technique.durationSeconds).toBeGreaterThan(0);
        expect(technique.inhaleSeconds).toBeGreaterThan(0);
        expect(technique.exhaleSeconds).toBeGreaterThan(0);
        expect(technique.safety.position).toBeTruthy();
        expect(technique.safety.stopCriteria).toBeTruthy();
        expect(technique.safety.emergency).toBeTruthy();
      }

      expect(result.find((technique) => technique.id === "box-breathing")?.durationSeconds).toBe(
        64,
      );
      expect(result.find((technique) => technique.id === "wim-hof")?.safety.warnings).toContain(
        "Intense rounds can, in rare cases, cause loss of consciousness.",
      );
    });
  });

  describe("logSession", () => {
    it("logs a breathwork session", async () => {
      const insertedRow = {
        id: "session-1",
        technique_id: "box-breathing",
        rounds: 4,
        duration_seconds: 64,
        started_at: "2026-03-22T10:00:00.000Z",
        notes: null,
        stress_before: 8,
        stress_after: 3,
        dizziness_after: false,
        perceived_effect: "better",
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });
      const result = await caller.logSession({
        techniqueId: "box-breathing",
        rounds: 4,
        durationSeconds: 64,
        startedAt: "2026-03-22T10:00:00.000Z",
        stressBefore: 8,
        stressAfter: 3,
        dizzinessAfter: false,
        perceivedEffect: "better",
      });

      expect(result).not.toBeNull();
      expect(result?.techniqueId).toBe("box-breathing");
      expect(result?.rounds).toBe(4);
      expect(result?.durationSeconds).toBe(64);
      expect(result).toMatchObject({
        stressBefore: 8,
        stressAfter: 3,
        dizzinessAfter: false,
        perceivedEffect: "better",
      });
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["breathwork"]);
    });

    it("does not invalidate when no session is written", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logSession({
        techniqueId: "box-breathing",
        rounds: 4,
        durationSeconds: 64,
        startedAt: "2026-03-22T10:00:00.000Z",
      });

      expect(result).toBeNull();
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });

    it("rejects out-of-range stress and unsupported perceived effects", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      await expect(
        caller.logSession({
          techniqueId: "box-breathing",
          rounds: 4,
          durationSeconds: 64,
          startedAt: "2026-03-22T10:00:00.000Z",
          stressBefore: 11,
        }),
      ).rejects.toThrow();

      await expect(
        caller.logSession({
          techniqueId: "box-breathing",
          rounds: 4,
          durationSeconds: 64,
          startedAt: "2026-03-22T10:00:00.000Z",
          perceivedEffect: "amazing",
        }),
      ).rejects.toThrow();
    });
  });

  describe("history", () => {
    it("returns empty history when no sessions", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.history({ days: 30 });

      expect(result).toEqual([]);
    });

    it("returns session history", async () => {
      const rows = [
        {
          id: "s1",
          technique_id: "box-breathing",
          rounds: 4,
          duration_seconds: 64,
          started_at: "2026-03-20T10:00:00.000Z",
          notes: null,
          stress_before: null,
          stress_after: null,
          dizziness_after: null,
          perceived_effect: null,
        },
        {
          id: "s2",
          technique_id: "resonance",
          rounds: 4,
          duration_seconds: 76,
          started_at: "2026-03-21T10:00:00.000Z",
          notes: "Before bed",
          stress_before: 6,
          stress_after: 2,
          dizziness_after: false,
          perceived_effect: "better",
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.history({ days: 30 });

      expect(result).toHaveLength(2);
      expect(result[0]?.techniqueId).toBe("box-breathing");
      expect(result[0]?.techniqueLabel).toBe("Box Breathing");
      expect(result[1]?.notes).toBe("Before bed");
      expect(result[1]?.techniqueLabel).toBe("Resonant Breathing");
      expect(result[1]).toMatchObject({
        stressBefore: 6,
        stressAfter: 2,
        dizzinessAfter: false,
        perceivedEffect: "better",
      });
    });
  });

  describe("outcomes", () => {
    it("returns server-computed rolling 30-day counts", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              technique_id: "box-breathing",
              session_count: 4,
              stress_pair_count: 3,
              lower_stress_count: 2,
              same_stress_count: 1,
              higher_stress_count: 0,
              perceived_effect_count: 3,
              better_count: 2,
              same_effect_count: 1,
              worse_count: 0,
              dizziness_report_count: 3,
              dizziness_count: 1,
            },
          ]),
        },
        userId: "user-1",
      });

      await expect(caller.outcomes()).resolves.toEqual({
        windowDays: 30,
        windowKind: "rolling-instant",
        techniques: [
          {
            techniqueId: "box-breathing",
            sessionCount: 4,
            stress: { reportCount: 3, lowerCount: 2, sameCount: 1, higherCount: 0 },
            perceivedEffect: { reportCount: 3, betterCount: 2, sameCount: 1, worseCount: 0 },
            dizziness: { reportCount: 3, yesCount: 1 },
          },
        ],
      });
    });
  });
});
