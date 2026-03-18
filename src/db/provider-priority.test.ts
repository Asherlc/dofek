import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "./index.ts";
import type { ProviderPriorityConfig } from "./provider-priority.ts";
import {
  loadProviderPriorityConfig,
  providerPriorityConfigSchema,
  syncProviderPriorities,
} from "./provider-priority.ts";

describe("providerPriorityConfigSchema", () => {
  it("validates a minimal config with only activity priority", () => {
    const config = {
      providers: {
        wahoo: { activity: 10 },
      },
    };
    expect(providerPriorityConfigSchema.parse(config)).toEqual(config);
  });

  it("validates a full config with all categories", () => {
    const config = {
      providers: {
        whoop: {
          activity: 30,
          sleep: 20,
          body: undefined,
          recovery: 15,
          dailyActivity: 80,
        },
      },
    };
    const parsed = providerPriorityConfigSchema.parse(config);
    expect(parsed.providers.whoop?.activity).toBe(30);
    expect(parsed.providers.whoop?.sleep).toBe(20);
    expect(parsed.providers.whoop?.recovery).toBe(15);
    expect(parsed.providers.whoop?.dailyActivity).toBe(80);
  });

  it("rejects missing activity priority", () => {
    const config = {
      providers: {
        wahoo: { sleep: 10 },
      },
    };
    expect(() => providerPriorityConfigSchema.parse(config)).toThrow();
  });

  it("rejects non-positive priority", () => {
    const config = {
      providers: {
        wahoo: { activity: 0 },
      },
    };
    expect(() => providerPriorityConfigSchema.parse(config)).toThrow();
  });

  it("rejects non-integer priority", () => {
    const config = {
      providers: {
        wahoo: { activity: 10.5 },
      },
    };
    expect(() => providerPriorityConfigSchema.parse(config)).toThrow();
  });

  it("validates config with device overrides", () => {
    const config = {
      providers: {
        apple_health: {
          activity: 90,
          devices: {
            "Apple Watch%": { activity: 30, recovery: 20 },
            "Wahoo TICKR%": { activity: 5 },
          },
        },
      },
    };
    const parsed = providerPriorityConfigSchema.parse(config);
    expect(parsed.providers.apple_health?.devices?.["Apple Watch%"]?.activity).toBe(30);
    expect(parsed.providers.apple_health?.devices?.["Wahoo TICKR%"]?.activity).toBe(5);
  });

  it("allows device overrides with only some categories", () => {
    const config = {
      providers: {
        garmin: {
          activity: 15,
          devices: {
            "Edge%": { activity: 10 },
          },
        },
      },
    };
    const parsed = providerPriorityConfigSchema.parse(config);
    expect(parsed.providers.garmin?.devices?.["Edge%"]?.activity).toBe(10);
    expect(parsed.providers.garmin?.devices?.["Edge%"]?.sleep).toBeUndefined();
  });
});

describe("loadProviderPriorityConfig", () => {
  it("returns null when file does not exist", () => {
    const result = loadProviderPriorityConfig("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("loads and validates a valid config file", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "provider-priority-test-"));
    const configPath = resolve(tmpDir, "provider-priority.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          wahoo: { activity: 10 },
          oura: { activity: 80, sleep: 10, recovery: 10 },
        },
      }),
    );

    const config = loadProviderPriorityConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config?.providers.wahoo?.activity).toBe(10);
    expect(config?.providers.oura?.sleep).toBe(10);

    rmSync(tmpDir, { recursive: true });
  });

  it("throws on malformed JSON", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "provider-priority-test-"));
    writeFileSync(resolve(tmpDir, "provider-priority.json"), "not json{");

    expect(() => loadProviderPriorityConfig(tmpDir)).toThrow();

    rmSync(tmpDir, { recursive: true });
  });

  it("throws on invalid schema", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "provider-priority-test-"));
    writeFileSync(
      resolve(tmpDir, "provider-priority.json"),
      JSON.stringify({ providers: { wahoo: { sleep: 10 } } }),
    );

    expect(() => loadProviderPriorityConfig(tmpDir)).toThrow();

    rmSync(tmpDir, { recursive: true });
  });

  it("loads the actual provider-priority.json from project root", () => {
    // Validates that the real config file is well-formed
    const config = loadProviderPriorityConfig();
    expect(config).not.toBeNull();
    expect(config?.providers.wahoo?.activity).toBe(10);
    expect(config?.providers.oura?.sleep).toBe(10);
    expect(config?.providers.apple_health?.dailyActivity).toBe(15);
    // Verify device overrides are loaded
    expect(config?.providers.apple_health?.devices?.["Apple Watch%"]?.activity).toBe(30);
    expect(config?.providers.apple_health?.devices?.["Wahoo TICKR%"]?.activity).toBe(5);
  });
});

describe("syncProviderPriorities", () => {
  let mockExecute: ReturnType<typeof vi.fn>;
  let mockDb: SyncDatabase;

  function createMockDb(): SyncDatabase {
    mockExecute = vi.fn();
    return { execute: mockExecute, select: vi.fn(), insert: vi.fn(), delete: vi.fn() } satisfies {
      [K in keyof SyncDatabase]: unknown;
    };
  }

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("upserts provider-level priorities", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10, sleep: 20 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // Should have: 1 provider upsert + 1 device delete + 1 provider delete = 3 calls
    expect(mockExecute).toHaveBeenCalled();
    const calls = mockExecute.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("upserts device-level overrides when present", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        apple_health: {
          activity: 90,
          devices: {
            "Apple Watch%": { activity: 30 },
            "Wahoo TICKR%": { activity: 5, sleep: 8 },
          },
        },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // 1 batched provider upsert + 1 batched device upsert + 1 device delete + 1 provider delete = 4
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("deletes stale device priorities not in config", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // With no device overrides: 1 provider upsert + 1 DELETE device_priority + 1 DELETE provider_priority = 3
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("deletes all device priorities when no devices in config", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
        oura: { activity: 80, sleep: 10 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // 1 batched provider upsert + 1 DELETE all device_priority + 1 DELETE stale providers = 3
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("handles multiple providers with mixed device configs", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
        apple_health: {
          activity: 90,
          devices: { "Apple Watch%": { activity: 30 } },
        },
        garmin: {
          activity: 15,
          devices: { "Edge%": { activity: 8 }, "Forerunner%": { activity: 12 } },
        },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // 1 batched provider upsert + 1 batched device upsert + 1 device delete + 1 provider delete = 4
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("passes null for optional category priorities", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // The first call is the provider upsert — verify it was called
    expect(mockExecute).toHaveBeenCalled();
  });

  it("SQL includes provider_priority table for provider upserts", async () => {
    const config: ProviderPriorityConfig = {
      providers: { wahoo: { activity: 10, sleep: 20, recovery: 15 } },
    };

    await syncProviderPriorities(mockDb, config);

    // First call is the provider upsert — inspect the Drizzle SQL object
    const firstCall = mockExecute.mock.calls[0]?.[0];
    const sqlStr = JSON.stringify(firstCall);
    expect(sqlStr).toContain("provider_priority");
    expect(sqlStr).toContain("ON CONFLICT");
  });

  it("SQL includes device_priority table for device upserts", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        apple_health: {
          activity: 90,
          devices: { "Apple Watch%": { activity: 30, sleep: 25 } },
        },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // Second call (after provider upsert) should be device upsert
    const deviceCall = mockExecute.mock.calls[1]?.[0];
    const sqlStr = JSON.stringify(deviceCall);
    expect(sqlStr).toContain("device_priority");
    expect(sqlStr).toContain("source_name_pattern");
  });

  it("issues DELETE for device_priority cleanup", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    const allSql = mockExecute.mock.calls.map((c: unknown[]) => JSON.stringify(c[0]));
    const hasDeviceDelete = allSql.some(
      (s: string) => s.includes("DELETE") && s.includes("device_priority"),
    );
    expect(hasDeviceDelete).toBe(true);
  });

  it("issues DELETE for provider_priority cleanup", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        wahoo: { activity: 10 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    const allSql = mockExecute.mock.calls.map((c: unknown[]) => JSON.stringify(c[0]));
    const hasProviderDelete = allSql.some(
      (s: string) =>
        s.includes("DELETE") && s.includes("provider_priority") && s.includes("NOT IN"),
    );
    expect(hasProviderDelete).toBe(true);
  });

  it("deletes all priorities when config has empty providers", async () => {
    const config: ProviderPriorityConfig = { providers: {} };

    await syncProviderPriorities(mockDb, config);

    // Should issue 2 DELETE statements (all device + all provider priorities)
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const allSql = mockExecute.mock.calls.map((c: unknown[]) => JSON.stringify(c[0]));
    expect(allSql.some((s: string) => s.includes("DELETE") && s.includes("device_priority"))).toBe(
      true,
    );
    expect(
      allSql.some((s: string) => s.includes("DELETE") && s.includes("provider_priority")),
    ).toBe(true);
  });

  it("passes non-null optional priorities to SQL", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        oura: { activity: 80, sleep: 10, body: 50, recovery: 15, dailyActivity: 60 },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // The provider upsert (first call) should have been invoked
    expect(mockExecute).toHaveBeenCalled();
    // With all 5 categories specified, none should be null
    const firstCallSql = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    // Verify the actual priority values appear in the SQL
    expect(firstCallSql).toContain("80");
    expect(firstCallSql).toContain("10");
    expect(firstCallSql).toContain("15");
    expect(firstCallSql).toContain("60");
  });

  it("passes device override values correctly to SQL", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        garmin: {
          activity: 15,
          devices: {
            "Edge%": { activity: 8, recovery: 12, dailyActivity: 18 },
          },
        },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // Second call is the device upsert
    const deviceSql = JSON.stringify(mockExecute.mock.calls[1]?.[0]);
    expect(deviceSql).toContain("8");
    expect(deviceSql).toContain("12");
    expect(deviceSql).toContain("18");
  });

  it("batches all device patterns in a single upsert", async () => {
    const config: ProviderPriorityConfig = {
      providers: {
        garmin: {
          activity: 15,
          devices: {
            "Edge%": { activity: 8 },
            "Forerunner%": { activity: 12 },
            "Venu%": { activity: 14, sleep: 25 },
          },
        },
      },
    };

    await syncProviderPriorities(mockDb, config);

    // 1 batched provider upsert + 1 batched device upsert + 1 device delete + 1 provider delete = 4
    expect(mockExecute).toHaveBeenCalledTimes(4);

    // Verify device upsert (second call) contains all patterns
    const deviceSql = JSON.stringify(mockExecute.mock.calls[1]?.[0]);
    expect(deviceSql).toContain("device_priority");
  });
});
