import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.ts";
import type { Provider } from "../providers/types.ts";
import { runSync } from "./runner.ts";

// Mock dedup module to make updateUserMaxHr throw
vi.mock("../db/dedup.ts", () => ({
  refreshDedupViews: vi.fn().mockResolvedValue(undefined),
  updateUserMaxHr: vi.fn().mockRejectedValue(new Error("Max HR update failed")),
}));

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    name: "Test",
    validate: () => null,
    sync: async () => ({
      provider: "test",
      recordsSynced: 2,
      errors: [],
      duration: 50,
    }),
    ...overrides,
  };
}

const mockDb = {} as Database;

describe("Sync Runner — updateUserMaxHr error handling", () => {
  it("completes sync even when updateUserMaxHr throws", async () => {
    const providers = [createMockProvider({ id: "b", name: "B" })];

    const result = await runSync(mockDb, new Date("2024-01-01"), providers);

    expect(result.results).toHaveLength(1);
    expect(result.totalRecords).toBe(2);
  });
});
