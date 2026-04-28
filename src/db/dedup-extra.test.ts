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

  it("refreshes only lightweight post-sync views", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    await refreshDedupViews(mockDb);

    expect(mockExecute).toHaveBeenCalledTimes(4);

    const calls = mockExecute.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain("fitness.v_activity");
    expect(calls[1]).toContain("fitness.v_sleep");
    expect(calls[2]).toContain("fitness.v_body_measurement");
    expect(calls[3]).toContain("fitness.v_daily_metrics");
    expect(calls.join("\n")).not.toContain("fitness.deduped_sensor");
    expect(calls.join("\n")).not.toContain("fitness.activity_summary");
    expect(calls.join("\n")).not.toContain("fitness.provider_stats");
  });

  it("does not fall back to blocking refresh during post-sync refreshes", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    mockExecute.mockRejectedValue(new Error("cannot refresh concurrently"));

    await expect(refreshDedupViews(mockDb)).rejects.toThrow("Failed to refresh 4 view(s)");

    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(mockExecute.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_activity"),
      expect.stringContaining("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep"),
      expect.stringContaining("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement"),
      expect.stringContaining("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_daily_metrics"),
    ]);
  });

  it("still self-heals missing views without issuing blocking refreshes first", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    const missingError = Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
      code: "42P01",
    });
    // First pass: v_activity fails with missing relation, rest succeed
    mockExecute
      .mockRejectedValueOnce(missingError) // v_activity CONCURRENTLY
      .mockResolvedValue(undefined); // all other views + retries succeed

    process.env.DATABASE_URL = "postgres://test:test@localhost/test";
    try {
      await refreshDedupViews(mockDb);
    } finally {
      delete process.env.DATABASE_URL;
    }

    // Should have called syncMaterializedViews
    expect(mockSyncMaterializedViews).toHaveBeenCalledWith("postgres://test:test@localhost/test");
    expect(
      mockExecute.mock.calls
        .map((call) => String(call[0]))
        .some((query) => query.includes("REFRESH MATERIALIZED VIEW fitness.v_activity")),
    ).toBe(false);
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

  it("does not issue fallback refreshes", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    mockExecute
      .mockRejectedValueOnce(new Error("has not been populated"))
      .mockResolvedValue(undefined);

    await expect(refreshDedupViews(mockDb)).rejects.toThrow("Failed to refresh 1 view(s)");

    const calls = mockExecute.mock.calls.map((call) => String(call[0]));
    expect(
      calls.some((query) => query.includes("REFRESH MATERIALIZED VIEW fitness.v_activity")),
    ).toBe(false);
    expect(calls[1]).toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep");
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
