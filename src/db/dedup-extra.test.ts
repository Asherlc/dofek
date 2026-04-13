import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock drizzle-orm's sql as both a tagged template function and an object with .raw
function mockSqlTaggedTemplate(strings: TemplateStringsArray, ..._values: unknown[]) {
  return `SQL:${strings.join("?")}`;
}
mockSqlTaggedTemplate.raw = vi.fn((str: string) => `RAW:${str}`);

vi.mock("drizzle-orm", () => ({
  sql: mockSqlTaggedTemplate,
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

const mockSyncMaterializedViews = vi
  .fn()
  .mockResolvedValue({ synced: 0, skipped: 0, refreshed: 0 });
vi.mock("./sync-views.ts", () => ({
  syncMaterializedViews: (...args: unknown[]) => mockSyncMaterializedViews(...args),
}));

const mockExecute = vi.fn().mockResolvedValue(undefined);

function createMockDb() {
  return {
    execute: mockExecute,
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
}

describe("refreshDedupViews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("refreshes all dedup views then rollup views", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    await refreshDedupViews(mockDb);

    // 5 dedup views + 1 rollup view = 6 total refreshes
    expect(mockExecute).toHaveBeenCalledTimes(6);

    // Verify order: dedup views first
    const calls = mockExecute.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain("fitness.v_activity");
    expect(calls[1]).toContain("fitness.v_sleep");
    expect(calls[2]).toContain("fitness.v_body_measurement");
    expect(calls[3]).toContain("fitness.v_daily_metrics");
    expect(calls[4]).toContain("fitness.deduped_sensor");
    // Then rollup views
    expect(calls[5]).toContain("fitness.activity_summary");
  });

  it("falls back to non-concurrent refresh when view has not been populated", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    // First call (CONCURRENTLY) fails with "has not been populated"
    // Second call (non-concurrent) succeeds
    let callCount = 0;
    mockExecute.mockImplementation(() => {
      callCount++;
      // Every odd call (CONCURRENTLY attempts) fails, even calls succeed
      if (callCount % 2 === 1) {
        return Promise.reject(new Error("has not been populated"));
      }
      return Promise.resolve(undefined);
    });

    await refreshDedupViews(mockDb);

    // Each view: 1 failed CONCURRENTLY + 1 fallback = 2 calls per view, 6 views = 12
    expect(mockExecute).toHaveBeenCalledTimes(12);
  });

  it("falls back when error mentions concurrently", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    // Fail only for the first view then succeed for rest
    let firstCall = true;
    mockExecute.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error("cannot refresh concurrently"));
      }
      return Promise.resolve(undefined);
    });

    await refreshDedupViews(mockDb);

    // First view: 1 failed + 1 fallback = 2; remaining 5 views: 1 each = 5; total = 7
    expect(mockExecute).toHaveBeenCalledTimes(7);
  });

  it("triggers view sync and retries when a view is missing", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const Sentry = await import("@sentry/node");
    const mockDb = createMockDb();

    const missingError = Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
      code: "42P01",
    });
    // First pass: v_activity fails with missing relation, rest succeed
    mockExecute
      .mockRejectedValueOnce(missingError) // v_activity CONCURRENTLY
      .mockRejectedValueOnce(missingError) // v_activity blocking fallback
      .mockResolvedValue(undefined); // all other views + retries succeed

    process.env.DATABASE_URL = "postgres://test:test@localhost/test";
    try {
      await refreshDedupViews(mockDb);
    } finally {
      delete process.env.DATABASE_URL;
    }

    // Should have called syncMaterializedViews
    expect(mockSyncMaterializedViews).toHaveBeenCalledWith("postgres://test:test@localhost/test");
    // Should have reported to Sentry
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(AggregateError),
      expect.objectContaining({ tags: { context: "viewSelfHeal" } }),
    );
  });

  it("throws when views are missing but DATABASE_URL is not set", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    const missingError = Object.assign(new Error("does not exist"), { code: "42P01" });
    mockExecute.mockRejectedValue(missingError);

    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(refreshDedupViews(mockDb)).rejects.toThrow(
        "Views missing and DATABASE_URL not available",
      );
    } finally {
      if (savedUrl) process.env.DATABASE_URL = savedUrl;
    }
  });

  it("throws AggregateError when retry after recreation still fails", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    const missingError = Object.assign(new Error("does not exist"), { code: "42P01" });
    // All calls fail — both initial and retry
    mockExecute.mockRejectedValue(missingError);

    process.env.DATABASE_URL = "postgres://test:test@localhost/test";
    try {
      await expect(refreshDedupViews(mockDb)).rejects.toThrow("after recreation");
    } finally {
      delete process.env.DATABASE_URL;
    }

    expect(mockSyncMaterializedViews).toHaveBeenCalled();
  });

  it("throws AggregateError with all failures after attempting all views", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    mockExecute.mockRejectedValue(new Error("connection refused"));

    const result = refreshDedupViews(mockDb);
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(refreshDedupViews(mockDb)).rejects.toThrow("Failed to refresh");
  });

  it("wraps non-Error exceptions into AggregateError after attempting all views", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    mockExecute.mockRejectedValue("string error");

    await expect(refreshDedupViews(mockDb)).rejects.toBeInstanceOf(AggregateError);
    await expect(refreshDedupViews(mockDb)).rejects.toThrow("Failed to refresh");
  });

  it("uses CONCURRENTLY in initial refresh attempt", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    await refreshDedupViews(mockDb);

    const firstCall = mockExecute.mock.calls[0]?.[0];
    expect(firstCall).toContain("CONCURRENTLY");
  });

  it("omits CONCURRENTLY in fallback refresh", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    // First call fails with "has not been populated", second succeeds
    mockExecute
      .mockRejectedValueOnce(new Error("has not been populated"))
      .mockResolvedValue(undefined);

    await refreshDedupViews(mockDb);

    // Second call (fallback) should NOT contain CONCURRENTLY
    const secondCall = mockExecute.mock.calls[1]?.[0];
    expect(secondCall).not.toContain("CONCURRENTLY");
    expect(secondCall).toContain("REFRESH MATERIALIZED VIEW");
  });
});

describe("updateUserMaxHr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("executes the UPDATE query", async () => {
    const { updateUserMaxHr } = await import("./dedup.ts");
    const mockDb = createMockDb();

    await updateUserMaxHr(mockDb);

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
