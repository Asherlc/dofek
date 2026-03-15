import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../db/index.ts";
import type { Provider } from "../../providers/types.ts";
import { runSync } from "../runner.ts";

// ============================================================
// Coverage test for line 58 — refreshDedupViews error path
// The runner imports refreshDedupViews and updateUserMaxHr;
// we mock the module to test error handling.
// ============================================================

// Mock the dedup module to make refreshDedupViews throw
vi.mock("../../db/dedup.ts", () => ({
  refreshDedupViews: vi.fn().mockRejectedValue(new Error("Materialized view refresh failed")),
  updateUserMaxHr: vi.fn().mockResolvedValue(undefined),
}));

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    name: "Test",
    validate: () => null,
    sync: async () => ({
      provider: "test",
      recordsSynced: 5,
      errors: [],
      duration: 100,
    }),
    ...overrides,
  };
}

const mockDb = Object.create(null);
const since = new Date("2024-01-01");

describe("Sync Runner — refreshDedupViews error handling", () => {
  it("completes sync even when refreshDedupViews throws", async () => {
    const providers = [
      createMockProvider({
        id: "a",
        name: "A",
        sync: async () => ({
          provider: "a",
          recordsSynced: 3,
          errors: [],
          duration: 50,
        }),
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    // Sync should still complete — the view refresh error is caught
    expect(result.results).toHaveLength(1);
    expect(result.totalRecords).toBe(3);
    expect(result.totalErrors).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
