import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock drizzle-orm's sql as both a tagged template function and an object with .raw
function mockSqlTaggedTemplate(strings: TemplateStringsArray, ..._values: unknown[]) {
  return `SQL:${strings.join("?")}`;
}
mockSqlTaggedTemplate.raw = vi.fn((str: string) => `RAW:${str}`);

vi.mock("drizzle-orm", () => ({
  sql: mockSqlTaggedTemplate,
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

    // 4 dedup views + 1 rollup view = 5 total refreshes
    expect(mockExecute).toHaveBeenCalledTimes(5);

    // Verify order: dedup views first
    const calls = mockExecute.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain("fitness.v_activity");
    expect(calls[1]).toContain("fitness.v_sleep");
    expect(calls[2]).toContain("fitness.v_body_measurement");
    expect(calls[3]).toContain("fitness.v_daily_metrics");
    // Then rollup views
    expect(calls[4]).toContain("fitness.activity_summary");
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

    // Each view: 1 failed CONCURRENTLY + 1 fallback = 2 calls per view, 5 views = 10
    expect(mockExecute).toHaveBeenCalledTimes(10);
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

    // First view: 1 failed + 1 fallback = 2; remaining 4 views: 1 each = 4; total = 6
    expect(mockExecute).toHaveBeenCalledTimes(6);
  });

  it("re-throws non-recoverable errors", async () => {
    const { refreshDedupViews } = await import("./dedup.ts");
    const mockDb = createMockDb();

    mockExecute.mockRejectedValue(new Error("connection refused"));

    await expect(refreshDedupViews(mockDb)).rejects.toThrow("connection refused");
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
