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

import { bodyRouter } from "./body.ts";
import { calendarRouter } from "./calendar.ts";
import { nutritionRouter } from "./nutrition.ts";
import { sleepRouter } from "./sleep.ts";

function makeCaller<T extends ReturnType<typeof import("../trpc.ts").router>>(
  routerDef: T,
  rows: Record<string, unknown>[] = [],
) {
  const factory = createTestCallerFactory(routerDef);
  return factory({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("bodyRouter", () => {
  describe("list", () => {
    it("returns body measurement rows", async () => {
      const rows = [{ id: "1", weight_kg: 80, recorded_at: "2024-01-01" }];
      const caller = makeCaller(bodyRouter, rows);
      const result = await caller.list({ days: 90 });
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("1");
      expect(result[0]?.weightKg).toBe(80);
      expect(result[0]?.recordedAt).toBe("2024-01-01");
    });

    it("returns empty array when no data", async () => {
      const caller = makeCaller(bodyRouter, []);
      const result = await caller.list({ days: 90 });
      expect(result).toEqual([]);
    });
  });
});

describe("calendarRouter", () => {
  describe("calendarData", () => {
    it("returns mapped calendar days", async () => {
      const rows = [
        {
          date: "2024-01-15",
          activity_count: 2,
          total_minutes: 120,
          activity_types: ["cycling", "running"],
        },
      ];
      const caller = makeCaller(calendarRouter, rows);
      const result = await caller.calendarData({ days: 365 });

      expect(result).toEqual([
        {
          date: "2024-01-15",
          activityCount: 2,
          totalMinutes: 120,
          activityTypes: ["cycling", "running"],
        },
      ]);
    });

    it("returns empty array when no activities", async () => {
      const caller = makeCaller(calendarRouter, []);
      const result = await caller.calendarData({ days: 365 });
      expect(result).toEqual([]);
    });
  });
});

describe("sleepRouter", () => {
  const sleepRow = {
    started_at: "2024-01-01T22:00:00Z",
    duration_minutes: 480,
    deep_minutes: 90,
    rem_minutes: 110,
    light_minutes: 250,
    awake_minutes: 30,
    efficiency_pct: 93.5,
  };

  describe("list", () => {
    it("returns sleep rows", async () => {
      const caller = makeCaller(sleepRouter, [sleepRow]);
      const result = await caller.list({ days: 30 });
      expect(result).toEqual([sleepRow]);
    });
  });

  describe("latest", () => {
    it("returns latest sleep record", async () => {
      const caller = makeCaller(sleepRouter, [sleepRow]);
      const result = await caller.latest();
      expect(result).toEqual(sleepRow);
    });

    it("returns null when no sleep data", async () => {
      const caller = makeCaller(sleepRouter, []);
      const result = await caller.latest();
      expect(result).toBeNull();
    });
  });
});

describe("nutritionRouter", () => {
  describe("daily", () => {
    it("returns nutrition rows", async () => {
      const rows = [{ date: "2024-01-15", calories: 2000, protein_g: 150 }];
      const caller = makeCaller(nutritionRouter, rows);
      const result = await caller.daily({ days: 30 });
      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2024-01-15");
      expect(result[0]?.calories).toBe(2000);
      expect(result[0]?.proteinGrams).toBe(150);
    });
  });
});
