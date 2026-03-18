import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Provider } from "../providers/types.ts";

const mockLoadConfig = vi.fn();
const mockSyncPriorities = vi.fn();
const mockRefreshViews = vi.fn();
const mockUpdateMaxHr = vi.fn();

vi.mock("../db/provider-priority.ts", () => ({
  loadProviderPriorityConfig: (...args: unknown[]) => mockLoadConfig(...args),
  syncProviderPriorities: (...args: unknown[]) => mockSyncPriorities(...args),
}));

vi.mock("../db/dedup.ts", () => ({
  refreshDedupViews: (...args: unknown[]) => mockRefreshViews(...args),
  updateUserMaxHr: (...args: unknown[]) => mockUpdateMaxHr(...args),
}));

vi.mock("../providers/index.ts", () => ({
  getEnabledProviders: () => [],
}));

import { runSync } from "./runner.ts";

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

describe("Sync Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(result.results[1]?.errors[0]?.message).toContain("API down");
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

  it("sets recordsSynced to 0 for rejected providers", async () => {
    const providers = [
      createMockProvider({
        id: "fail",
        name: "Fail",
        sync: async () => {
          throw new Error("Network error");
        },
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(result.results[0]?.recordsSynced).toBe(0);
    expect(result.results[0]?.provider).toBe("fail");
  });

  it("aggregates errors from multiple failing providers", async () => {
    const providers = [
      createMockProvider({
        id: "fail1",
        name: "Fail1",
        sync: async () => {
          throw new Error("err1");
        },
      }),
      createMockProvider({
        id: "fail2",
        name: "Fail2",
        sync: async () => {
          throw new Error("err2");
        },
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(result.totalErrors).toBe(2);
    expect(result.totalRecords).toBe(0);
  });

  it("includes provider errors in result array", async () => {
    const providers = [
      createMockProvider({
        id: "ok",
        name: "OK",
        sync: async () => ({
          provider: "ok",
          recordsSynced: 5,
          errors: [{ message: "partial failure" }],
          duration: 10,
        }),
      }),
    ];

    const result = await runSync(mockDb, since, providers);

    expect(result.totalRecords).toBe(5);
    expect(result.totalErrors).toBe(1);
    expect(result.results[0]?.errors).toHaveLength(1);
  });
});

describe("Sync Runner — provider priority sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and applies provider priority config before refreshing views", async () => {
    const fakeConfig = { providers: { wahoo: { activity: 10 } } };
    mockLoadConfig.mockReturnValue(fakeConfig);

    await runSync(mockDb, since, []);

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockSyncPriorities).toHaveBeenCalledWith(mockDb, fakeConfig);
    expect(mockRefreshViews).toHaveBeenCalledWith(mockDb);
  });

  it("skips priority sync when config file is missing", async () => {
    mockLoadConfig.mockReturnValue(null);

    await runSync(mockDb, since, []);

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockSyncPriorities).not.toHaveBeenCalled();
  });

  it("continues sync when priority sync throws", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("ENOENT: file read error");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runSync(mockDb, since, [createMockProvider()]);

    expect(result.results).toHaveLength(1);
    expect(result.totalRecords).toBe(5);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("provider priorities"),
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it("calls updateUserMaxHr before priority sync", async () => {
    const callOrder: string[] = [];
    mockUpdateMaxHr.mockImplementation(() => {
      callOrder.push("maxHr");
    });
    mockLoadConfig.mockImplementation(() => {
      callOrder.push("loadConfig");
      return null;
    });
    mockRefreshViews.mockImplementation(() => {
      callOrder.push("refreshViews");
    });

    await runSync(mockDb, since, []);

    expect(callOrder).toEqual(["maxHr", "loadConfig", "refreshViews"]);
  });

  it("refreshes materialized views after priority sync", async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });

    await runSync(mockDb, since, []);

    expect(mockRefreshViews).toHaveBeenCalledWith(mockDb);
  });

  it("logs refresh messages", async () => {
    mockLoadConfig.mockReturnValue(null);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSync(mockDb, since, []);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Refreshing materialized views"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("views refreshed"));
    spy.mockRestore();
  });

  it("continues when refreshDedupViews throws", async () => {
    mockLoadConfig.mockReturnValue(null);
    mockRefreshViews.mockRejectedValue(new Error("connection lost"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runSync(mockDb, since, []);

    expect(result.results).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("refresh views"), expect.any(Error));
    spy.mockRestore();
  });

  it("continues when updateUserMaxHr throws", async () => {
    mockLoadConfig.mockReturnValue(null);
    mockUpdateMaxHr.mockRejectedValue(new Error("max HR failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runSync(mockDb, since, []);

    expect(result.results).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("max HR"), expect.any(Error));
    spy.mockRestore();
  });
});
