import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCachedProtectedQuery, mockCaptureException, mockInvalidateUserQueryDomains } =
  vi.hoisted(() => ({
    mockCachedProtectedQuery: vi.fn(),
    mockCaptureException: vi.fn(),
    mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: { query: (...args: unknown[]) => Promise<unknown[]> };
    }>()
    .create();
  mockCachedProtectedQuery.mockImplementation(() => trpc.procedure);
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
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
    sensorStore: makeSensorStore(),
  });
}

function makeSleepRow(
  date: string,
  durationMinutes: number,
  deepMinutes: number,
  remMinutes: number,
  efficiencyPct: number,
) {
  return {
    date,
    started_at: `${date}T04:00:00Z`,
    ended_at: `${date}T11:00:00Z`,
    duration_minutes: durationMinutes,
    deep_minutes: deepMinutes,
    rem_minutes: remMinutes,
    light_minutes: durationMinutes - deepMinutes - remMinutes,
    awake_minutes: 0,
    efficiency_pct: efficiencyPct,
    staging_available: true,
  };
}

function makeSensorStore(bodyRows: Record<string, unknown>[] = [], sleepRows: unknown[] = []) {
  return {
    query: vi.fn(async (_schema: unknown, query: string) => {
      if (query.includes("analytics.v_body_measurement")) return bodyRows;
      if (query.includes("analytics.daily_sleep")) return sleepRows;
      return [{ date: "2026-01-01", resting_hr: 52 }];
    }),
  };
}

describe("lifeEventsRouter", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
    mockInvalidateUserQueryDomains.mockClear();
  });

  it("uses short caches for life event read queries", () => {
    const routerConstructionCachePolicies = mockCachedProtectedQuery.mock.calls.map(
      (call) => call[0],
    );

    expect(routerConstructionCachePolicies).toEqual([{ maxAge: 120_000 }, { maxAge: 120_000 }]);
  });

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
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["lifeEvents"]);
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

    it("returns a nullable association to the personal experiment that owns an annotation", async () => {
      const caller = makeCaller([
        {
          id: "evt-experiment",
          label: "Late flight",
          started_at: "2026-08-08",
          ended_at: null,
          category: "lifestyle",
          ongoing: false,
          notes: "Arrived after midnight",
          personal_experiment_id: "11111111-1111-4111-8111-111111111111",
          created_at: "2026-08-08T10:00:00Z",
          user_id: "user-1",
        },
      ]);

      const result = await caller.create({
        label: "Late flight",
        startedAt: "2026-08-08",
        personalExperimentId: "11111111-1111-4111-8111-111111111111",
      });

      expect(result.personal_experiment_id).toBe("11111111-1111-4111-8111-111111111111");
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

    it("returns a precondition error when the linked experiment is unavailable", async () => {
      const caller = makeCaller([]);

      await expect(
        caller.create({
          label: "Travel",
          startedAt: "2026-03-15",
          personalExperimentId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Choose one of your own experiments to link this annotation.",
      });
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Choose one of your own experiments to link this annotation.",
        }),
        { tags: { trpcPath: "lifeEvents.create" } },
      );
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
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["lifeEvents"]);
    });

    it("returns null when no changes provided", async () => {
      const caller = makeCaller([]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toBeNull();
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });

    it("returns a precondition error when the linked experiment is unavailable", async () => {
      const caller = makeCaller([]);

      await expect(
        caller.update({
          id: "00000000-0000-0000-0000-000000000001",
          personalExperimentId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Choose one of your own experiments to link this annotation.",
      });
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Choose one of your own experiments to link this annotation.",
        }),
        { tags: { trpcPath: "lifeEvents.update" } },
      );
    });
  });

  describe("delete", () => {
    it("deletes a life event and returns success", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toEqual({ success: true });
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["lifeEvents"]);
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
          { period: "before", measurements: 4, avg_weight: 75, avg_body_fat: 15 },
          { period: "after", measurements: 4, avg_weight: 74, avg_body_fat: 14.5 },
        ]);

      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(
          [
            { period: "before", measurements: 4, avg_weight: 75, avg_body_fat: 15 },
            { period: "after", measurements: 4, avg_weight: 74, avg_body_fat: 14.5 },
          ],
          [
            makeSleepRow("2026-01-01", 420, 60, 90, 85),
            makeSleepRow("2026-02-01", 450, 70, 100, 88),
          ],
        ),
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
