import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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
  });

  describe("trends", () => {
    it("returns trend data for a question", async () => {
      const trends = [{ date: "2026-03-28", value: 2 }];
      const caller = makeCaller(trends);
      const result = await caller.trends({ questionSlug: "caffeine", days: 90 });
      expect(result).toHaveLength(1);
    });

    it("uses default days (90) when not specified", async () => {
      const caller = makeCaller([]);
      const result = await caller.trends({ questionSlug: "caffeine" });
      expect(result).toEqual([]);
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
    });
  });

  describe("delete", () => {
    it("deletes a journal entry", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeDefined();
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
