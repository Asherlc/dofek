import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProviderPriorityConfig, providerPriorityConfigSchema } from "./provider-priority.ts";

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
            "Apple Watch": { activity: 30, recovery: 20 },
            "Wahoo TICKR%": { activity: 5 },
          },
        },
      },
    };
    const parsed = providerPriorityConfigSchema.parse(config);
    expect(parsed.providers.apple_health?.devices?.["Apple Watch"]?.activity).toBe(30);
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
    expect(config?.providers.apple_health?.devices?.["Apple Watch"]?.activity).toBe(30);
    expect(config?.providers.apple_health?.devices?.["Wahoo TICKR%"]?.activity).toBe(5);
  });
});
