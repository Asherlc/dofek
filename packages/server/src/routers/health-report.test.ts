import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    publicProcedure: t.procedure,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
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

import { healthReportRouter } from "./health-report.ts";

const createCaller = createTestCallerFactory(healthReportRouter);

describe("healthReportRouter", () => {
  describe("generate", () => {
    it("creates a shared report and returns a share token", async () => {
      const insertedRow = {
        id: "report-1",
        share_token: "abc123",
        report_type: "weekly",
        report_data: { summary: "test" },
        expires_at: null,
        created_at: "2026-03-22T00:00:00Z",
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });
      const result = await caller.generate({
        reportType: "weekly",
        reportData: { summary: "test" },
      });

      expect(result).not.toBeNull();
      expect(result?.shareToken).toBe("abc123");
      expect(result?.reportType).toBe("weekly");
    });
  });

  describe("getShared", () => {
    it("returns null when token not found", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.getShared({ token: "nonexistent" });

      expect(result).toBeNull();
    });

    it("returns shared report data for valid token", async () => {
      const row = {
        id: "report-1",
        share_token: "abc123",
        report_type: "weekly",
        report_data: { summary: "test data" },
        expires_at: null,
        created_at: "2026-03-22T00:00:00Z",
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([row]) },
        userId: "user-1",
      });
      const result = await caller.getShared({ token: "abc123" });

      expect(result).not.toBeNull();
      expect(result?.reportType).toBe("weekly");
      expect(result?.reportData).toEqual({ summary: "test data" });
    });
  });

  describe("myReports", () => {
    it("returns empty list when no reports", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.myReports();

      expect(result).toEqual([]);
    });

    it("returns list of user reports", async () => {
      const rows = [
        {
          id: "r1",
          share_token: "token1",
          report_type: "weekly",
          expires_at: null,
          created_at: "2026-03-20T00:00:00Z",
        },
        {
          id: "r2",
          share_token: "token2",
          report_type: "healthspan",
          expires_at: null,
          created_at: "2026-03-21T00:00:00Z",
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.myReports();

      expect(result).toHaveLength(2);
      expect(result[0]?.reportType).toBe("weekly");
    });
  });
});
