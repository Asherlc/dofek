import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../db/index.js";
import type { Provider } from "../../providers/types.js";
import { runSync } from "../runner.js";

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

const mockDb = {} as Database;
const since = new Date("2024-01-01");

describe("Sync Runner", () => {
  it("runs sync for all provided providers", async () => {
    const syncFn = vi.fn(async () => ({
      provider: "a",
      recordsSynced: 3,
      errors: [],
      duration: 50,
    }));

    const providers = [
      createMockProvider({ id: "a", name: "A", sync: syncFn }),
      createMockProvider({ id: "b", name: "B", sync: syncFn }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(syncFn).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    expect(result.totalRecords).toBe(6);
    expect(result.totalErrors).toBe(0);
  });

  it("handles provider failures gracefully", async () => {
    const providers = [
      createMockProvider({
        id: "good",
        name: "Good",
        sync: async () => ({
          provider: "good",
          recordsSynced: 10,
          errors: [],
          duration: 50,
        }),
      }),
      createMockProvider({
        id: "bad",
        name: "Bad",
        sync: async () => {
          throw new Error("API down");
        },
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(result.results).toHaveLength(2);
    expect(result.totalRecords).toBe(10);
    expect(result.totalErrors).toBe(1);
    expect(result.results[1].errors[0].message).toContain("API down");
  });

  it("returns zero results for empty provider list", async () => {
    const result = await runSync(mockDb, since, []);

    expect(result.results).toHaveLength(0);
    expect(result.totalRecords).toBe(0);
    expect(result.totalErrors).toBe(0);
  });

  it("tracks total duration", async () => {
    const providers = [
      createMockProvider({
        id: "slow",
        name: "Slow",
        sync: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { provider: "slow", recordsSynced: 1, errors: [], duration: 50 };
        },
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(result.duration).toBeGreaterThanOrEqual(40);
  });
});
