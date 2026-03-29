import { describe, expect, it, vi } from "vitest";
import {
  ADDITIVE_QUANTITY_TYPES,
  NON_ADDITIVE_QUANTITY_TYPES,
  syncHealthKitToServer,
} from "./health-kit-sync";

describe("syncHealthKitToServer", () => {
  function createMockClient() {
    return {
      healthKitSync: {
        pushQuantitySamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 5, errors: [] }),
        },
        pushWorkouts: {
          mutate: vi.fn().mockResolvedValue({ inserted: 2 }),
        },
        pushSleepSamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 1 }),
        },
      },
    };
  }

  function createMockHealthKit() {
    return {
      queryDailyStatistics: vi.fn().mockResolvedValue([{ date: "2026-03-21", value: 5000 }]),
      queryQuantitySamples: vi.fn().mockResolvedValue([
        {
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 72,
          unit: "count/min",
          startDate: "2026-03-21T10:00:00Z",
          endDate: "2026-03-21T10:00:00Z",
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
          uuid: "sample-1",
        },
      ]),
      queryWorkouts: vi.fn().mockResolvedValue([
        {
          uuid: "workout-1",
          workoutType: "running",
          startDate: "2026-03-21T07:00:00Z",
          endDate: "2026-03-21T08:00:00Z",
          duration: 3600,
          totalEnergyBurned: 500,
          totalDistance: 10000,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
      ]),
      querySleepSamples: vi.fn().mockResolvedValue([
        {
          uuid: "sleep-1",
          startDate: "2026-03-20T22:00:00Z",
          endDate: "2026-03-21T06:00:00Z",
          value: "asleepCore",
          sourceName: "Apple Watch",
        },
      ]),
    };
  }

  it("queries all quantity types and pushes to server", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(result.inserted).toBeGreaterThan(0);
    expect(healthKit.queryDailyStatistics).toHaveBeenCalledTimes(ADDITIVE_QUANTITY_TYPES.length);
    expect(healthKit.queryQuantitySamples).toHaveBeenCalledTimes(
      NON_ADDITIVE_QUANTITY_TYPES.length,
    );
    expect(healthKit.queryWorkouts).toHaveBeenCalledTimes(1);
    expect(healthKit.querySleepSamples).toHaveBeenCalledTimes(1);
  });

  it("reports progress via callback", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const onProgress = vi.fn();

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();
    const progressMessages = onProgress.mock.calls.map((call: string[]) => call[0]);
    expect(progressMessages.some((m: string) => m.includes("Querying"))).toBe(true);
  });

  it("uses full history when syncRangeDays is null", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: null,
    });

    // First call should have a very old start date
    const firstCall = healthKit.queryDailyStatistics.mock.calls[0];
    const startDate = new Date(firstCall[1]);
    expect(startDate.getFullYear()).toBeLessThanOrEqual(1970);
  });

  it("batches large sample sets into groups of 500", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();

    // Return 750 samples for one type
    healthKit.queryQuantitySamples.mockResolvedValue(
      Array.from({ length: 750 }, (_, i) => ({
        type: "HKQuantityTypeIdentifierHeartRate",
        value: 72,
        unit: "count/min",
        startDate: `2026-03-21T${String(i % 24).padStart(2, "0")}:00:00Z`,
        endDate: `2026-03-21T${String(i % 24).padStart(2, "0")}:00:00Z`,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
        uuid: `sample-${i}`,
      })),
    );

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    // Should have called pushQuantitySamples at least twice (2 batches of 500 + remainder)
    expect(
      client.healthKitSync.pushQuantitySamples.mutate.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("returns errors from the server", async () => {
    const client = createMockClient();
    client.healthKitSync.pushQuantitySamples.mutate.mockResolvedValue({
      inserted: 3,
      errors: ["Invalid sample format"],
    });
    const healthKit = createMockHealthKit();

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("normalizes workout fields with null defaults", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "w-1",
        workoutType: "running",
        startDate: "2026-03-21T07:00:00Z",
        endDate: "2026-03-21T08:00:00Z",
        duration: 3600,
        totalEnergyBurned: undefined,
        totalDistance: undefined,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
    ]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    const workoutCall = client.healthKitSync.pushWorkouts.mutate.mock.calls[0];
    expect(workoutCall[0].workouts[0].totalEnergyBurned).toBeNull();
    expect(workoutCall[0].workouts[0].totalDistance).toBeNull();
  });
});

describe("quantity type constants", () => {
  it("additive types include steps and active energy", () => {
    expect(ADDITIVE_QUANTITY_TYPES).toContain("HKQuantityTypeIdentifierStepCount");
    expect(ADDITIVE_QUANTITY_TYPES).toContain("HKQuantityTypeIdentifierActiveEnergyBurned");
  });

  it("non-additive types include heart rate and HRV", () => {
    expect(NON_ADDITIVE_QUANTITY_TYPES).toContain("HKQuantityTypeIdentifierHeartRate");
    expect(NON_ADDITIVE_QUANTITY_TYPES).toContain(
      "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    );
  });
});
