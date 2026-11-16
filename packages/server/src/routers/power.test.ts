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

function makeCaller(sensorStore?: ActivitySensorStore) {
  const store = sensorStore ?? makeMockSensorStore([]);
  const db = { execute: vi.fn().mockResolvedValue([{ activity_count: 1 }]) };
  return {
    caller: createCaller({ db, userId: "user-1", timezone: "UTC", sensorStore: store }),
    sensorStore: store,
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

  it("accepts a same-day FTP suggestion range and passes its inclusive bounds", async () => {
    const sensorStore = makeMockSensorStore([]);
    const { caller } = makeCaller(sensorStore);

    const result = await caller.ftpSuggestions({
      start_date: "2026-06-15",
      end_date: "2026-06-15",
    });

    expect(result.methods).toHaveLength(2);
    expect(vi.mocked(sensorStore.query)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toMatchObject({
      startDate: "2026-06-15",
      endDate: "2026-06-15",
    });
  });

  it("rejects a reversed FTP suggestion range before querying power curves", async () => {
    const sensorStore = makeMockSensorStore([]);
    const { caller } = makeCaller(sensorStore);

    await expect(
      caller.ftpSuggestions({ start_date: "2026-06-16", end_date: "2026-06-15" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(vi.mocked(sensorStore.query)).not.toHaveBeenCalled();
  });

  it("requires the analytics sensor store for FTP suggestions", async () => {
    const callerWithoutStore = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: undefined,
    });

    await expect(
      callerWithoutStore.ftpSuggestions({
        start_date: "2026-06-15",
        end_date: "2026-06-15",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
