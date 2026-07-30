import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory } from "./test-helpers.ts";

const { mockInvalidateAllQueries, mockInvalidateUserQueryDomains } = vi.hoisted(() => ({
  mockInvalidateAllQueries: vi.fn().mockResolvedValue(undefined),
  mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateAllQueries: mockInvalidateAllQueries,
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

import { journalRouter } from "./journal.ts";

const createCaller = createTestCallerFactory(journalRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("journalRouter", () => {
  beforeEach(() => {
    mockInvalidateAllQueries.mockClear();
    mockInvalidateUserQueryDomains.mockClear();
  });

  describe("questions", () => {
    it("returns available questions", async () => {
      const questions = [
        { id: "q1", slug: "caffeine", display_name: "Caffeine", category: "substance" },
      ];
      const caller = makeCaller(questions);
      const result = await caller.questions();
      expect(result).toHaveLength(1);
      expect(result[0]?.slug).toBe("caffeine");
    });

    it("returns empty array when no questions", async () => {
      const caller = makeCaller([]);
      const result = await caller.questions();
      expect(result).toEqual([]);
    });
  });

  describe("entries", () => {
    it("returns journal entries", async () => {
      const entries = [
        { id: "e1", date: "2026-03-28", question_slug: "caffeine", answer_numeric: 2 },
      ];
      const caller = makeCaller(entries);
      const result = await caller.entries({ days: 30 });
      expect(result).toHaveLength(1);
    });

    it("uses default days (30) when not specified", async () => {
      const caller = makeCaller([]);
      const result = await caller.entries({});
      expect(result).toEqual([]);
    });

    it("uses a lower date bound for finite selected ranges", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.entries({ days: 30 });

      expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND je.date >=");
    });

    it("omits the lower date bound when days is null", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.entries({ days: null });

      const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("WHERE je.user_id =");
      expect(queryText).not.toContain("je.date >=");
    });
  });

  describe("trends", () => {
    it("returns server-authored multi-series trend evidence", async () => {
      const caller = makeCaller([
        {
          id: "e1",
          date: "2026-03-28",
          provider_id: "dofek",
          question_slug: "caffeine",
          display_name: "Caffeine",
          category: "substance",
          data_type: "numeric",
          unit: "mg",
          answer_text: null,
          answer_numeric: 2,
          impact_score: null,
        },
      ]);

      const result = await caller.trends({
        days: 3,
        endDate: "2026-03-28",
      });

      expect(result).toMatchObject({
        window: {
          startDate: "2026-03-26",
          endDate: "2026-03-28",
          dayCount: 3,
          gapRepresentation: "explicit_daily",
        },
        statement:
          "1 exact observation across 1 of 3 days. Missing days indicate no journal value was recorded.",
        uncertainty: {
          status: "unavailable",
          statement: "Uncertainty interval: not available for raw journal observations.",
        },
        series: [
          {
            questionSlug: "caffeine",
            displayName: "Caffeine",
            dataType: "numeric",
            unit: "mg",
            points: [
              { date: "2026-03-26", value: null, source: null },
              { date: "2026-03-27", value: null, source: null },
              {
                date: "2026-03-28",
                value: 2,
                source: { providerId: "dofek", label: "Dofek" },
              },
            ],
          },
        ],
      });
    });

    it("uses the canonical default window when not specified", async () => {
      const caller = makeCaller([]);
      const result = await caller.trends({});
      expect(result.window.dayCount).toBe(30);
      expect(result.series).toEqual([]);
    });

    it("uses exact lower and upper date bounds for finite selected ranges", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.trends({ days: 30, endDate: "2026-03-28" });

      const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("AND je.date >");
      expect(queryText).toContain("AND je.date <=");
      expect(queryText).not.toContain("AND je.question_slug =");
    });

    it("omits the lower date bound when days is null", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.trends({ days: null, endDate: "2026-03-28" });

      const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("WHERE je.user_id =");
      expect(queryText).not.toContain("je.date >=");
      expect(queryText).toContain("AND je.date <=");
    });
  });

  describe("create", () => {
    it("creates a journal entry", async () => {
      const created = [{ id: "e-new", date: "2026-03-28", question_slug: "caffeine" }];
      const caller = makeCaller(created);
      const result = await caller.create({
        date: "2026-03-28",
        questionSlug: "caffeine",
        answerNumeric: 3,
      });
      expect(result).toBeDefined();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["journalEntries"]);
    });

    it("rejects invalid date format", async () => {
      const caller = makeCaller([]);
      await expect(
        caller.create({ date: "not-a-date", questionSlug: "caffeine" }),
      ).rejects.toThrow();
    });

    it("uses default null for optional fields", async () => {
      const created = [{ id: "e-new", date: "2026-03-28", question_slug: "caffeine" }];
      const caller = makeCaller(created);
      // Only required fields — answerText and answerNumeric default to null
      const result = await caller.create({
        date: "2026-03-28",
        questionSlug: "caffeine",
      });
      expect(result).toBeDefined();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["journalEntries"]);
    });
  });

  describe("update", () => {
    it("updates a journal entry", async () => {
      const updated = [{ id: "e1", answer_numeric: 5 }];
      const caller = makeCaller(updated);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        answerNumeric: 5,
      });
      expect(result).toBeDefined();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["journalEntries"]);
    });

    it("does not invalidate when no journal entry is updated", async () => {
      const caller = makeCaller([]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toBeNull();
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes a journal entry", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeDefined();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["journalEntries"]);
    });
  });

  describe("createQuestion", () => {
    it("creates a custom question", async () => {
      const created = [{ slug: "energy_level", display_name: "My Question" }];
      const caller = makeCaller(created);
      const result = await caller.createQuestion({
        slug: "energy_level",
        displayName: "My Question",
        category: "custom",
        dataType: "numeric",
      });
      expect(result).toBeDefined();
      expect(mockInvalidateAllQueries).toHaveBeenCalledOnce();
    });

    it("rejects invalid slug format", async () => {
      const caller = makeCaller([]);
      await expect(
        caller.createQuestion({
          slug: "Invalid-SLUG",
          displayName: "Test",
          category: "custom",
          dataType: "numeric",
        }),
      ).rejects.toThrow();
    });

    it("uses default null for unit", async () => {
      const created = [{ slug: "test", display_name: "Test" }];
      const caller = makeCaller(created);
      // unit defaults to null
      const result = await caller.createQuestion({
        slug: "test",
        displayName: "Test",
        category: "wellness",
        dataType: "boolean",
      });
      expect(result).toBeDefined();
    });
  });
});
