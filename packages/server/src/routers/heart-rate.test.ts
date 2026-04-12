import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

// Mock executeWithSchema
const mockExecuteWithSchema = vi.fn();
vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: (...args: unknown[]) => mockExecuteWithSchema(...args),
  dateStringSchema: z.string(),
  timestampStringSchema: z.union([z.string(), z.date()]).transform((value) =>
    value instanceof Date ? value.toISOString() : value,
  ),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/date-window.ts", () => ({
  endDateSchema: z.string().optional(),
}));

vi.mock("@dofek/providers/providers", () => ({
  providerLabel: (id: string) => {
    const labels: Record<string, string> = {
      whoop_ble: "WHOOP BLE",
      apple_health: "Apple Health",
    };
    return labels[id] ?? id;
  },
}));

describe("heartRateRouter", () => {
  beforeEach(() => {
    mockExecuteWithSchema.mockReset();
  });

  it("exports a dailyBySource procedure", async () => {
    const { heartRateRouter } = await import("./heart-rate.ts");
    expect(heartRateRouter).toBeDefined();
    expect(heartRateRouter._def.procedures.dailyBySource).toBeDefined();
  });

  it("dailyBySource returns samples grouped by provider", async () => {
    mockExecuteWithSchema.mockResolvedValue([
      { provider_id: "whoop_ble", recorded_at: "2026-04-12T10:00:00Z", heart_rate: 72 },
      { provider_id: "whoop_ble", recorded_at: "2026-04-12T10:01:00Z", heart_rate: 74 },
      { provider_id: "apple_health", recorded_at: "2026-04-12T10:00:00Z", heart_rate: 70 },
    ]);

    const { heartRateRouter } = await import("./heart-rate.ts");
    const createCaller = createTestCallerFactory(heartRateRouter);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    const result = await caller.dailyBySource({ date: "2026-04-12" });

    expect(result).toHaveLength(2);

    const bleSeries = result.find((series) => series.providerId === "whoop_ble");
    expect(bleSeries).toBeDefined();
    expect(bleSeries?.samples).toHaveLength(2);
    expect(bleSeries?.samples[0].heartRate).toBe(72);

    const appleSeries = result.find((series) => series.providerId === "apple_health");
    expect(appleSeries).toBeDefined();
    expect(appleSeries?.samples).toHaveLength(1);
  });

  it("dailyBySource returns empty array when no data", async () => {
    mockExecuteWithSchema.mockResolvedValue([]);

    const { heartRateRouter } = await import("./heart-rate.ts");
    const createCaller = createTestCallerFactory(heartRateRouter);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    const result = await caller.dailyBySource({ date: "2026-04-12" });
    expect(result).toEqual([]);
  });
});
