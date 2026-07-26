import { describe, expect, it, vi } from "vitest";
import {
  ADDITIVE_QUANTITY_TYPES,
  NON_ADDITIVE_QUANTITY_TYPES,
  syncHealthKitToServer,
} from "./health-kit-sync";
import { captureException } from "./telemetry";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

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
        pushWorkoutRoutes: {
          mutate: vi.fn().mockResolvedValue({ inserted: 10 }),
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
      queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
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

  it("queries walking biomechanics quantity samples", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    const queriedTypes = healthKit.queryQuantitySamples.mock.calls.map(
      ([typeId]: [string, string, string]) => typeId,
    );

    expect(queriedTypes).toEqual(
      expect.arrayContaining([
        "HKQuantityTypeIdentifierWalkingSpeed",
        "HKQuantityTypeIdentifierWalkingStepLength",
        "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
        "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
        "HKQuantityTypeIdentifierAppleWalkingSteadiness",
      ]),
    );
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

  it("starts incremental daily statistics at the local day boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T15:30:00-07:00"));
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const expectedStartDate = new Date();
    expectedStartDate.setDate(expectedStartDate.getDate() - 1);
    expectedStartDate.setHours(0, 0, 0, 0);

    try {
      await syncHealthKitToServer({
        trpcClient: client,
        healthKit,
        syncRangeDays: 1,
      });
    } finally {
      vi.useRealTimers();
    }

    const firstCall = healthKit.queryDailyStatistics.mock.calls[0];
    expect(firstCall[1]).toBe(expectedStartDate.toISOString());
  });

  it("continues to workout sync when daily statistics authorization is not determined", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryDailyStatistics.mockRejectedValue(
      Object.assign(new Error("localized system message"), {
        code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
      }),
    );

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(result.inserted).toBeGreaterThan(0);
    expect(healthKit.queryWorkouts).toHaveBeenCalledTimes(1);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workouts: expect.arrayContaining([expect.objectContaining({ uuid: "workout-1" })]),
      }),
    );
  });

  it("throws daily statistics errors without the stable not-determined code", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const dailyStatisticsError = Object.assign(new Error("Authorization not determined"), {
      code: "QUERY_ERROR",
    });
    healthKit.queryDailyStatistics.mockRejectedValue(dailyStatisticsError);

    await expect(
      syncHealthKitToServer({
        trpcClient: client,
        healthKit,
        syncRangeDays: 1,
      }),
    ).rejects.toThrow(dailyStatisticsError);
    expect(healthKit.queryWorkouts).not.toHaveBeenCalled();
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

  it("reports structured sync stages with quantity batch sizes", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const samples = Array.from({ length: 750 }, (_, sampleIndex) => ({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: 72,
      unit: "count/min",
      startDate: `2026-03-21T${String(sampleIndex % 24).padStart(2, "0")}:00:00Z`,
      endDate: `2026-03-21T${String(sampleIndex % 24).padStart(2, "0")}:00:00Z`,
      sourceName: "Apple Watch",
      sourceBundle: "com.apple.health",
      uuid: `sample-${sampleIndex}`,
    }));
    healthKit.queryDailyStatistics.mockResolvedValue([]);
    healthKit.queryQuantitySamples.mockImplementation(async (typeIdentifier: string) =>
      typeIdentifier === "HKQuantityTypeIdentifierHeartRate" ? samples : [],
    );
    const onStage = vi.fn();

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
      onStage,
    });

    expect(onStage).toHaveBeenCalledWith({
      operation: "queryDailyStatistics",
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
    });
    expect(onStage).toHaveBeenCalledWith({
      operation: "pushQuantitySamples",
      batchIndex: 1,
      batchCount: 2,
      itemCount: 500,
    });
    expect(onStage).toHaveBeenCalledWith({
      operation: "pushQuantitySamples",
      batchIndex: 2,
      batchCount: 2,
      itemCount: 250,
    });
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

  it("queries routes for each workout and pushes to server", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkoutRoutes.mockResolvedValue([
      { date: "2026-03-21T07:00:00Z", lat: 40.7128, lng: -74.006, altitude: 10 },
      { date: "2026-03-21T07:00:01Z", lat: 40.7129, lng: -74.0061 },
    ]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(healthKit.queryWorkoutRoutes).toHaveBeenCalledWith("workout-1");
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).toHaveBeenCalledWith({
      routes: [
        {
          workoutUuid: "workout-1",
          sourceName: "Apple Watch",
          locations: [
            { date: "2026-03-21T07:00:00Z", lat: 40.7128, lng: -74.006, altitude: 10 },
            { date: "2026-03-21T07:00:01Z", lat: 40.7129, lng: -74.0061 },
          ],
        },
      ],
    });
  });

  it("skips route push when no workouts have GPS data", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkoutRoutes.mockResolvedValue([]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(healthKit.queryWorkoutRoutes).toHaveBeenCalledTimes(1);
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).not.toHaveBeenCalled();
  });

  it("records route query errors as non-fatal without aborting sync", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const routeQueryError = new Error("Route permission denied");
    healthKit.queryWorkoutRoutes.mockRejectedValue(routeQueryError);

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    // Sync should complete successfully despite route error
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes("Route query"))).toBe(true);
    // Route push should not have been attempted
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(routeQueryError, {
      source: "health-kit-workout-route-query",
      workoutUuid: "workout-1",
    });
  });

  it("propagates locked-device route errors without reporting them", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const lockedDeviceError = Object.assign(
      new Error("HealthKit data is unavailable while the device is locked"),
      {
        code: "HEALTHKIT_DATABASE_INACCESSIBLE",
      },
    );
    healthKit.queryWorkoutRoutes.mockRejectedValue(lockedDeviceError);
    vi.mocked(captureException).mockClear();

    await expect(
      syncHealthKitToServer({
        trpcClient: client,
        healthKit,
        syncRangeDays: 1,
      }),
    ).rejects.toBe(lockedDeviceError);

    expect(captureException).not.toHaveBeenCalled();
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).not.toHaveBeenCalled();
  });

  it("records route push errors as non-fatal", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkoutRoutes.mockResolvedValue([
      { date: "2026-03-21T07:00:00Z", lat: 40.7128, lng: -74.006 },
    ]);
    const routePushError = new Error("Server error");
    client.healthKitSync.pushWorkoutRoutes.mutate.mockRejectedValue(routePushError);

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(result.inserted).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes("Push workout routes"))).toBe(true);
    expect(captureException).toHaveBeenCalledWith(routePushError, {
      source: "health-kit-workout-route-push",
      routeCount: 1,
    });
  });

  it("does not query routes when there are no workouts", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkouts.mockResolvedValue([]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(healthKit.queryWorkoutRoutes).not.toHaveBeenCalled();
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).not.toHaveBeenCalled();
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
    expect(workoutCall[0].workouts[0].totalDistance).toBeNull();
    expect(workoutCall[0].windowStart).toEqual(expect.any(String));
    expect(workoutCall[0].windowEnd).toEqual(expect.any(String));
  });

  it("passes through workout metadata and workoutActivities to server", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "w-strength",
        workoutType: "49",
        startDate: "2026-03-21T10:00:00Z",
        endDate: "2026-03-21T11:00:00Z",
        duration: 3600,
        totalDistance: null,
        sourceName: "Strong",
        sourceBundle: "io.strongapp.strong",
        metadata: { HKIndoorWorkout: 1, customKey: "some-value" },
        workoutActivities: [
          {
            uuid: "act-1",
            activityType: 49,
            startDate: "2026-03-21T10:00:00Z",
            endDate: "2026-03-21T10:15:00Z",
            metadata: { exerciseName: "Squat" },
          },
        ],
      },
    ]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    const workoutCall = client.healthKitSync.pushWorkouts.mutate.mock.calls[0];
    const workout = workoutCall[0].workouts[0];
    expect(workout.metadata).toEqual({ HKIndoorWorkout: 1, customKey: "some-value" });
    expect(workout.workoutActivities).toEqual([
      {
        uuid: "act-1",
        activityType: 49,
        startDate: "2026-03-21T10:00:00Z",
        endDate: "2026-03-21T10:15:00Z",
        metadata: { exerciseName: "Squat" },
      },
    ]);
  });
});

describe("quantity type constants", () => {
  it("additive types include steps", () => {
    expect(ADDITIVE_QUANTITY_TYPES).toContain("HKQuantityTypeIdentifierStepCount");
  });

  it("non-additive types include heart rate and HRV", () => {
    expect(NON_ADDITIVE_QUANTITY_TYPES).toContain("HKQuantityTypeIdentifierHeartRate");
    expect(NON_ADDITIVE_QUANTITY_TYPES).toContain(
      "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    );
  });
});
