import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string;
      timezone: string;
      sensorStore?: ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { LONG: 3_600_000 },
  };
});

const { powerRouter } = await import("./power.ts");

const createCaller = createTestCallerFactory(powerRouter);

function makeCaller() {
  const sensorStore = makeMockSensorStore([]);
  const db = { execute: vi.fn().mockResolvedValue([{ activity_count: 1 }]) };
  return {
    caller: createCaller({ db, userId: "user-1", timezone: "UTC", sensorStore }),
    sensorStore,
  };
}

describe("powerRouter", () => {
  it("accepts null days for all-time power curve requests", async () => {
    const { caller, sensorStore } = makeCaller();

    await caller.powerCurve({ days: null });

    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryParams).not.toHaveProperty("days");
  });

  it("keeps the existing default power curve window when days is omitted", async () => {
    const { caller, sensorStore } = makeCaller();

    await caller.powerCurve({});

    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryParams).toHaveProperty("days", 90);
  });

  it("accepts null days for all-time eFTP trend requests", async () => {
    const { caller, sensorStore } = makeCaller();

    await caller.eftpTrend({ days: null });

    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryParams).not.toHaveProperty("days");
  });

  it("keeps the existing default eFTP trend window when days is omitted", async () => {
    const { caller, sensorStore } = makeCaller();

    await caller.eftpTrend({});

    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryParams).toHaveProperty("days", 365);
  });
});
