import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
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

import { lifeEventsRouter } from "./life-events.ts";

const createCaller = createTestCallerFactory(lifeEventsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("lifeEventsRouter", () => {
  describe("list", () => {
    it("returns life events from repository", async () => {
      const events = [
        {
          id: "evt-1",
          label: "Started meditation",
          started_at: "2026-01-15",
          ended_at: null,
          category: "wellness",
          ongoing: true,
          notes: null,
          created_at: "2026-01-15T10:00:00Z",
        },
      ];
      const caller = makeCaller(events);
      const result = await caller.list();

      expect(result).toHaveLength(1);
      expect(result[0]?.label).toBe("Started meditation");
    });

    it("returns empty array when no events", async () => {
      const caller = makeCaller([]);
      const result = await caller.list();
      expect(result).toEqual([]);
    });
  });

  describe("create", () => {
    it("creates a life event and returns the row", async () => {
      const insertedRow = {
        id: "evt-new",
        label: "New job",
        started_at: "2026-03-01",
        ended_at: null,
        category: "career",
        ongoing: false,
        notes: null,
        created_at: "2026-03-01T10:00:00Z",
        user_id: "user-1",
      };

      const caller = makeCaller([insertedRow]);
      const result = await caller.create({
        label: "New job",
        startedAt: "2026-03-01",
      });

      expect(result.id).toBe("evt-new");
      expect(result.label).toBe("New job");
    });

    it("accepts all optional fields", async () => {
      const insertedRow = {
        id: "evt-2",
        label: "Injury",
        started_at: "2026-02-01",
        ended_at: "2026-02-28",
        category: "health",
        ongoing: false,
        notes: "Knee sprain",
        created_at: "2026-02-01T10:00:00Z",
        user_id: "user-1",
      };

      const caller = makeCaller([insertedRow]);
      const result = await caller.create({
        label: "Injury",
        startedAt: "2026-02-01",
        endedAt: "2026-02-28",
        category: "health",
        ongoing: false,
        notes: "Knee sprain",
      });

      expect(result.ended_at).toBe("2026-02-28");
      expect(result.notes).toBe("Knee sprain");
    });

    it("uses default values for optional fields", async () => {
      const insertedRow = {
        id: "evt-3",
        label: "Started running",
        started_at: "2026-03-15",
        ended_at: null,
        category: null,
        ongoing: false,
        notes: null,
        created_at: "2026-03-15T10:00:00Z",
        user_id: "user-1",
      };

      const caller = makeCaller([insertedRow]);
      // Only providing required fields — defaults should apply
      const result = await caller.create({
        label: "Started running",
        startedAt: "2026-03-15",
      });

      expect(result.ongoing).toBe(false);
      expect(result.ended_at).toBeNull();
      expect(result.category).toBeNull();
      expect(result.notes).toBeNull();
    });
  });

  describe("update", () => {
    it("updates a life event by id", async () => {
      const updatedRow = {
        id: "evt-1",
        label: "Updated label",
        started_at: "2026-01-15",
        ended_at: null,
        category: "wellness",
        ongoing: true,
        notes: null,
        created_at: "2026-01-15T10:00:00Z",
        user_id: "user-1",
      };

      const caller = makeCaller([updatedRow]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        label: "Updated label",
      });

      expect(result?.label).toBe("Updated label");
    });

    it("returns null when no changes provided", async () => {
      const caller = makeCaller([]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes a life event and returns success", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe("analyze", () => {
    it("returns analysis for a life event", async () => {
      // First call returns the event, subsequent calls return comparison data
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([
          { started_at: "2026-01-15", ended_at: "2026-02-15", ongoing: false },
        ])
        .mockResolvedValueOnce([
          {
            period: "before",
            days: 30,
            avg_resting_hr: 60,
            avg_hrv: 55,
            avg_steps: 8000,
            avg_active_energy: 500,
          },
          {
            period: "after",
            days: 30,
            avg_resting_hr: 58,
            avg_hrv: 60,
            avg_steps: 9000,
            avg_active_energy: 550,
          },
        ])
        .mockResolvedValueOnce([
          {
            period: "before",
            nights: 28,
            avg_sleep_min: 420,
            avg_deep_min: 60,
            avg_rem_min: 90,
            avg_efficiency: 85,
          },
          {
            period: "after",
            nights: 30,
            avg_sleep_min: 450,
            avg_deep_min: 70,
            avg_rem_min: 100,
            avg_efficiency: 88,
          },
        ])
        .mockResolvedValueOnce([
          { period: "before", measurements: 4, avg_weight: 75, avg_body_fat: 15 },
          { period: "after", measurements: 4, avg_weight: 74, avg_body_fat: 14.5 },
        ]);

      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.analyze({
        id: "00000000-0000-0000-0000-000000000001",
        windowDays: 30,
      });

      expect(result).not.toBeNull();
      expect(result?.metrics).toHaveLength(2);
      expect(result?.sleep).toHaveLength(2);
      expect(result?.bodyComp).toHaveLength(2);
    });

    it("returns null when event not found", async () => {
      const caller = makeCaller([]);
      const result = await caller.analyze({
        id: "00000000-0000-0000-0000-000000000001",
        windowDays: 30,
      });

      expect(result).toBeNull();
    });

    it("uses default windowDays when not specified", async () => {
      const caller = makeCaller([]);
      // Should not throw — default windowDays (30) should be applied
      const result = await caller.analyze({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeNull();
    });
  });
});
