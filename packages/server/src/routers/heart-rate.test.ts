import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const { mockCachedProtectedQuery } = vi.hoisted(() => ({
  mockCachedProtectedQuery: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      sensorStore?: ActivitySensorStore;
      userId: string;
      timezone: string;
    }>()
    .create();
  mockCachedProtectedQuery.mockImplementation(() => trpc.procedure);
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("@dofek/providers/providers", () => ({
  providerLabel: (id: string) => {
    const labels: Record<string, string> = {
      whoop_ble: "WHOOP (Bluetooth)",
      apple_health: "Apple Health",
    };
    return labels[id] ?? id;
  },
}));

describe("heartRateRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a medium cache for daily source queries", async () => {
    await import("./heart-rate.ts");

    expect(mockCachedProtectedQuery).toHaveBeenCalledWith({ maxAge: 600_000 });
  });

  it("exports a dailyBySource procedure", async () => {
    const { heartRateRouter } = await import("./heart-rate.ts");
    expect(heartRateRouter._def.procedures.dailyBySource).toBeDefined();
  });

  it("dailyBySource returns samples grouped by provider", async () => {
    const { heartRateRouter } = await import("./heart-rate.ts");
    const createCaller = createTestCallerFactory(heartRateRouter);
    const caller = createCaller({
      db: { execute: vi.fn() },
      sensorStore: makeMockSensorStore([
        { provider_id: "whoop_ble", recorded_at: "2026-04-12T10:00:00Z", heart_rate: 72 },
        { provider_id: "whoop_ble", recorded_at: "2026-04-12T10:01:00Z", heart_rate: 74 },
        { provider_id: "apple_health", recorded_at: "2026-04-12T10:00:00Z", heart_rate: 70 },
      ]),
      userId: "user-1",
      timezone: "UTC",
    });

    const result = await caller.dailyBySource({ date: "2026-04-12" });

    expect(result).toHaveLength(2);
    expect(result.find((series) => series.providerId === "whoop_ble")?.samples).toHaveLength(2);
    expect(result.find((series) => series.providerId === "apple_health")?.samples).toHaveLength(1);
  });
});
