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
      recordsSynced: 1,
      errors: [],
      duration: 10,
    }),
    ...overrides,
  };
}

const mockDb = Object.create(null);
const since = new Date("2024-01-01");

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
    // Views refresh must happen after priority sync
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
    expect(result.totalRecords).toBe(1);
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
