import * as Sentry from "@sentry/node";
import { refreshMaterializedView } from "dofek/db/materialized-view-refresh";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BaseRepository } from "./base-repository.ts";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("dofek/db/materialized-view-refresh", () => ({
  refreshMaterializedView: vi.fn(),
}));

vi.mock("dofek/db/materialized-views", () => ({
  ACTIVITY_VIEWS: ["fitness.activity_summary", "fitness.v_activity"],
}));

// Concrete subclass for testing
class TestRepository extends BaseRepository {
  async runQuery(schema: z.ZodType, sqlQuery: ReturnType<typeof sql>) {
    return this.query(schema, sqlQuery);
  }

  async runQueryWithViewRefresh<TResult>(
    queryFn: () => Promise<TResult[]>,
    days: number,
    label: string,
    baseCountSql?: ReturnType<typeof sql>,
  ) {
    return this.queryWithViewRefresh(queryFn, days, label, baseCountSql);
  }

  // Expose protected fields for assertions
  get exposedDb() {
    return this.db;
  }
  get exposedUserId() {
    return this.userId;
  }
  get exposedTimezone() {
    return this.timezone;
  }
}

describe("BaseRepository", () => {
  const mockDb = { execute: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores db, userId, and timezone", () => {
    const repo = new TestRepository(mockDb, "user-1", "America/New_York");
    expect(repo.exposedDb).toBe(mockDb);
    expect(repo.exposedUserId).toBe("user-1");
    expect(repo.exposedTimezone).toBe("America/New_York");
  });

  it("defaults timezone to UTC when omitted", () => {
    const repo = new TestRepository(mockDb, "user-1");
    expect(repo.exposedTimezone).toBe("UTC");
  });

  it("query() delegates to executeWithSchema and parses rows", async () => {
    const schema = z.object({ value: z.number() });
    mockDb.execute.mockResolvedValueOnce([{ value: 42 }]);

    const repo = new TestRepository(mockDb, "user-1");
    const rows = await repo.runQuery(schema, sql`SELECT 42 AS value`);

    expect(rows).toEqual([{ value: 42 }]);
    expect(mockDb.execute).toHaveBeenCalledOnce();
  });

  it("query() throws on schema mismatch", async () => {
    const schema = z.object({ value: z.number() });
    mockDb.execute.mockResolvedValueOnce([{ value: "not-a-number" }]);

    const repo = new TestRepository(mockDb, "user-1");
    await expect(repo.runQuery(schema, sql`SELECT 'bad'`)).rejects.toThrow();
  });

  it("refreshes stale activity views, logs warning context, and retries the query", async () => {
    const repo = new TestRepository(mockDb, "user-1");
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1 }]);

    mockDb.execute.mockResolvedValueOnce([{ count: "2" }]);
    vi.mocked(refreshMaterializedView).mockResolvedValue({
      durationMs: 10,
      fallbackUsed: false,
      mode: "concurrent",
    });

    const result = await repo.runQueryWithViewRefresh(
      queryFn,
      30,
      "activityList",
      sql`SELECT 2 AS count`,
    );

    expect(result).toEqual([{ id: 1 }]);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Stale activity materialized views detected (activityList)",
      {
        level: "warning",
        tags: { userId: "user-1" },
        extra: { baseCount: 2 },
      },
    );
    expect(refreshMaterializedView).toHaveBeenNthCalledWith(1, mockDb, "fitness.activity_summary", {
      source: "server.activity_view_self_heal",
    });
    expect(refreshMaterializedView).toHaveBeenNthCalledWith(2, mockDb, "fitness.v_activity", {
      source: "server.activity_view_self_heal",
    });
  });

  it("captures refresh failures with user context and returns the original empty result", async () => {
    const repo = new TestRepository(mockDb, "user-1");
    const queryFn = vi.fn().mockResolvedValueOnce([]);
    const refreshError = new Error("refresh failed");

    mockDb.execute.mockResolvedValueOnce([{ count: "1" }]);
    vi.mocked(refreshMaterializedView).mockRejectedValue(refreshError);

    const result = await repo.runQueryWithViewRefresh(
      queryFn,
      30,
      "activityList",
      sql`SELECT 1 AS count`,
    );

    expect(result).toEqual([]);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(refreshError, {
      tags: { userId: "user-1", context: "staleViewRefresh" },
    });
  });
});
