import { describe, expect, it, vi } from "vitest";
import {
  ADDITIVE_QUANTITY_TYPES,
  BACKGROUND_HEALTH_KIT_TYPES,
  MENSTRUAL_FLOW_TYPE_IDENTIFIER,
  NON_ADDITIVE_QUANTITY_TYPES,
  syncHealthKitObserverChanges,
  syncHealthKitToServer,
} from "./health-kit-sync";
import { captureException } from "./telemetry";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

const runningQuantities = [
  ["HKQuantityTypeIdentifierRunningSpeed", "m/s", 3.5],
  ["HKQuantityTypeIdentifierRunningPower", "W", 240],
  ["HKQuantityTypeIdentifierRunningStrideLength", "m", 1.2],
  ["HKQuantityTypeIdentifierRunningGroundContactTime", "ms", 250],
  ["HKQuantityTypeIdentifierRunningVerticalOscillation", "mm", 85],
] as const;

function runningSample(type: string, unit: string, value: number) {
  return {
    type,
    unit,
    value,
    startDate: "2026-10-28T10:00:00.125Z",
    endDate: "2026-10-28T10:00:00.875Z",
    sourceName: "Apple Watch",
    sourceBundle: "com.apple.health",
    uuid: `parent-${type}`,
  };
}

describe("syncHealthKitToServer", () => {
  it.each(runningQuantities)(
    "uploads historical %s observations unchanged",
    async (type, unit, value) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const sample = runningSample(type, unit, value);
      healthKit.queryQuantitySamples.mockImplementation(async (identifier) =>
        identifier === type ? [sample] : [],
      );

      await syncHealthKitToServer({ trpcClient: client, healthKit, syncRangeDays: null });

      expect(healthKit.queryQuantitySamples).toHaveBeenCalledWith(
        type,
        new Date(0).toISOString(),
        expect.any(String),
      );
      expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
        samples: expect.arrayContaining([sample]),
      });
    },
  );
  function createMockClient() {
    return {
      clinicalRecords: {
        push: {
          mutate: vi.fn().mockResolvedValue({ upserted: 0 }),
        },
      },
      healthKitSync: {
        recordSync: {
          mutate: vi.fn().mockResolvedValue({ recorded: true }),
        },
        pushQuantitySamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 5, errors: [] }),
        },
        deleteQuantitySamples: {
          mutate: vi.fn().mockResolvedValue({ deleted: 1 }),
        },
        pushRunningStepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
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
      queryClinicalRecords: vi.fn().mockResolvedValue([]),
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
      queryCategorySamples: vi.fn().mockResolvedValue([]),
      queryAnchoredSamples: vi.fn().mockResolvedValue({
        queryId: "query-1",
        samples: [],
        deletedUUIDs: [],
      }),
      completeAnchoredQuery: vi.fn().mockResolvedValue(true),
      queryRunningStepSamples: vi.fn().mockResolvedValue({ workouts: [], samples: [] }),
      queryRunningStepChanges: vi.fn().mockResolvedValue({
        hasMore: false,
        workouts: [],
        samples: [],
        deletedUUIDs: [],
        queryId: null,
      }),
      queryWorkouts: vi.fn().mockResolvedValue([
        {
          uuid: "workout-1",
          workoutType: "running",
          startDate: "2026-03-21T07:00:00Z",
          endDate: "2026-03-21T08:00:00Z",
          duration: 3600,
          totalDistance: 10000,
          device: { name: "My Watch", model: "Watch7,12" },
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

  it("captures unexpected category query failures and propagates the original error", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const error = new Error("Category database read failed");
    healthKit.queryCategorySamples.mockRejectedValueOnce(error);
    await expect(
      syncHealthKitToServer({ trpcClient: client, healthKit, syncRangeDays: 1 }),
    ).rejects.toBe(error);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        source: "health-kit-category-query",
        typeIdentifier: MENSTRUAL_FLOW_TYPE_IDENTIFIER,
      }),
    );
  });

  it("syncs raw running snapshots and historical deltas separately from daily totals", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const workout = {
      uuid: "run",
      workoutType: "37",
      startDate: "2020-01-01T10:00:00Z",
      endDate: "2020-01-01T11:00:00Z",
      duration: 3600,
      totalDistance: null,
      sourceName: "Watch",
      sourceBundle: "watch",
    };
    const raw = {
      uuid: "steps",
      type: "HKQuantityTypeIdentifierStepCount",
      value: 3,
      unit: "count",
      startDate: "2020-01-01T10:00:00Z",
      endDate: "2020-01-01T10:00:01Z",
      sourceName: "Watch",
      sourceBundle: "watch",
      workoutUuids: ["run"],
    };
    healthKit.queryRunningStepSamples.mockResolvedValue({ workouts: [workout], samples: [raw] });
    healthKit.queryRunningStepChanges.mockResolvedValue({
      hasMore: false,
      workouts: [workout],
      samples: [raw],
      deletedUUIDs: ["old-parent"],
      queryId: "steps-anchor",
    });
    client.healthKitSync.deleteQuantitySamples.mutate.mockResolvedValue({ deleted: 1 });
    const result = await syncHealthKitToServer({ trpcClient: client, healthKit, syncRangeDays: 7 });
    expect(healthKit.queryRunningStepSamples).toHaveBeenCalledTimes(1);
    expect(client.healthKitSync.pushRunningStepSamples.mutate).toHaveBeenCalledWith({
      workouts: [workout],
      samples: [raw],
    });
    expect(client.healthKitSync.deleteQuantitySamples.mutate).toHaveBeenCalledWith({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      deletedUUIDs: ["old-parent"],
    });
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      "steps-anchor",
      true,
    );
    expect(result.deleted).toBe(1);
    expect(
      client.healthKitSync.pushQuantitySamples.mutate.mock.calls
        .flatMap(([input]) => input.samples)
        .every((sample) => sample.uuid !== "steps"),
    ).toBe(true);
  });

  it("rejects incomplete raw workout context before committing a step cursor", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryRunningStepChanges.mockResolvedValue({
      hasMore: false,
      workouts: [],
      samples: [{ uuid: "missing-context", workoutUuids: ["run"] }],
      deletedUUIDs: [],
      queryId: "pending",
    });
    await expect(
      syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: ["HKQuantityTypeIdentifierStepCount"],
      }),
    ).rejects.toThrow(/workout context/i);
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      "pending",
      false,
    );
  });

  it("applies device erasure cutoff to raw contexts and child intervals", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const cutoff = "2026-03-21T07:00:00Z";
    const workouts = [
      { uuid: "old", startDate: cutoff },
      { uuid: "new", startDate: "2026-03-21T08:00:00Z" },
    ];
    const samples = [
      { uuid: "old-child", startDate: cutoff, workoutUuids: ["new"] },
      { uuid: "erased-workout-child", startDate: "2026-03-21T08:00:01Z", workoutUuids: ["old"] },
      { uuid: "kept", startDate: "2026-03-21T08:00:01Z", workoutUuids: ["new"] },
    ];
    healthKit.queryRunningStepSamples.mockResolvedValue({ workouts, samples });
    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKQuantityTypeIdentifierStepCount"],
      minimumSampleDate: cutoff,
    });
    expect(client.healthKitSync.pushRunningStepSamples.mutate).toHaveBeenCalledWith({
      workouts: [{ ...workouts[1], totalDistance: null }],
      samples: [samples[2]],
    });
    expect(healthKit.queryRunningStepChanges).toHaveBeenCalledWith(cutoff);
  });

  it.each(["HKWorkoutTypeIdentifier", "HKQuantityTypeIdentifierStepCount"])(
    "refreshes associated raw steps on %s observer delivery",
    async (typeIdentifier) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      await syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: [typeIdentifier],
      });
      expect(healthKit.queryRunningStepSamples).toHaveBeenCalledTimes(1);
      expect(healthKit.queryRunningStepChanges).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["upload", "delete", "read"])(
    "does not commit step anchor on %s failure",
    async (stage) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const error = new Error("raw steps failed");
      healthKit.queryRunningStepChanges.mockResolvedValue({
        hasMore: false,
        workouts: [],
        samples: [],
        deletedUUIDs: ["old"],
        queryId: "pending",
      });
      if (stage === "upload") {
        healthKit.queryRunningStepChanges.mockResolvedValue({
          hasMore: false,
          workouts: [{ uuid: "run", startDate: "2026-03-21T07:00:00Z" }],
          samples: [{ uuid: "steps", workoutUuids: ["run"], startDate: "2026-03-21T07:00:00Z" }],
          deletedUUIDs: [],
          queryId: "pending",
        });
        client.healthKitSync.pushRunningStepSamples.mutate.mockRejectedValue(error);
      }
      if (stage === "delete")
        client.healthKitSync.deleteQuantitySamples.mutate.mockRejectedValue(error);
      if (stage === "read") healthKit.queryRunningStepChanges.mockRejectedValue(error);
      await expect(
        syncHealthKitObserverChanges({
          trpcClient: client,
          healthKit,
          typeIdentifiers: ["HKQuantityTypeIdentifierStepCount"],
        }),
      ).rejects.toBe(error);
      expect(healthKit.completeAnchoredQuery).not.toHaveBeenCalledWith(
        "HKQuantityTypeIdentifierStepCount",
        "pending",
        true,
      );
      if (stage !== "read")
        expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
          "HKQuantityTypeIdentifierStepCount",
          "pending",
          false,
        );
    },
  );

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
    expect(healthKit.queryCategorySamples).toHaveBeenCalledWith(
      MENSTRUAL_FLOW_TYPE_IDENTIFIER,
      expect.any(String),
      expect.any(String),
    );
    expect(BACKGROUND_HEALTH_KIT_TYPES).toContain(MENSTRUAL_FLOW_TYPE_IDENTIFIER);
  });

  it("pushes mapped clinical records only during an explicit sync", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const clinicalRecord = {
      uuid: "659ee585-b399-4c21-841f-97fe49fdc465",
      clinicalType: "condition" as const,
      displayName: "Migraine",
      sourceName: "Example Health System",
      fhirVersion: "4.0.1",
      fhir: { resourceType: "Condition", id: "condition-1" },
      downloadedAt: "2026-04-25T17:15:30.000Z",
    };
    healthKit.queryDailyStatistics.mockResolvedValue([]);
    healthKit.queryQuantitySamples.mockResolvedValue([]);
    healthKit.queryCategorySamples.mockResolvedValue([]);
    healthKit.queryWorkouts.mockResolvedValue([]);
    healthKit.querySleepSamples.mockResolvedValue([]);
    client.healthKitSync.pushWorkouts.mutate.mockResolvedValue({ inserted: 0 });
    healthKit.queryClinicalRecords.mockImplementation(async (typeIdentifier: string) =>
      typeIdentifier === "HKClinicalTypeIdentifierConditionRecord" ? [clinicalRecord] : [],
    );
    client.clinicalRecords.push.mutate.mockResolvedValue({ upserted: 1 });

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 7,
    });

    expect(healthKit.queryClinicalRecords).toHaveBeenCalledTimes(9);
    expect(healthKit.queryClinicalRecords).toHaveBeenCalledWith(
      "HKClinicalTypeIdentifierConditionRecord",
      expect.any(String),
      expect.any(String),
    );
    expect(client.clinicalRecords.push.mutate).toHaveBeenCalledWith({
      records: [
        {
          externalId: clinicalRecord.uuid,
          clinicalType: clinicalRecord.clinicalType,
          displayName: clinicalRecord.displayName,
          sourceName: clinicalRecord.sourceName,
          fhirVersion: clinicalRecord.fhirVersion,
          fhir: clinicalRecord.fhir,
          downloadedAt: clinicalRecord.downloadedAt,
        },
      ],
    });
    expect(result).toEqual({ deleted: 0, inserted: 1, errors: [] });
  });

  it("batches clinical records at the server endpoint limit", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryDailyStatistics.mockResolvedValue([]);
    healthKit.queryQuantitySamples.mockResolvedValue([]);
    healthKit.queryCategorySamples.mockResolvedValue([]);
    healthKit.queryWorkouts.mockResolvedValue([]);
    healthKit.querySleepSamples.mockResolvedValue([]);
    client.healthKitSync.pushWorkouts.mutate.mockResolvedValue({ inserted: 0 });
    healthKit.queryClinicalRecords.mockImplementation(async (typeIdentifier: string) =>
      typeIdentifier === "HKClinicalTypeIdentifierConditionRecord"
        ? Array.from({ length: 101 }, (_, index) => ({
            uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            clinicalType: "condition" as const,
            displayName: `Condition ${index}`,
            sourceName: "Example Health System",
            fhirVersion: "4.0.1",
            fhir: { resourceType: "Condition", id: `condition-${index}` },
            downloadedAt: "2026-04-25T17:15:30.000Z",
          }))
        : [],
    );
    client.clinicalRecords.push.mutate.mockImplementation(async ({ records }) => ({
      upserted: records.length,
    }));

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 7,
    });

    expect(
      client.clinicalRecords.push.mutate.mock.calls.map(([input]) => input.records.length),
    ).toEqual([100, 1]);
    expect(result.inserted).toBe(101);
  });

  it("reports specific clinical-record progress and structured stages", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const onProgress = vi.fn();
    const onStage = vi.fn();
    healthKit.queryClinicalRecords.mockImplementation(async (typeIdentifier: string) =>
      typeIdentifier === "HKClinicalTypeIdentifierLabResultRecord"
        ? [
            {
              uuid: "659ee585-b399-4c21-841f-97fe49fdc465",
              clinicalType: "labResult",
              displayName: "CBC",
              sourceName: "Example Health System",
              fhirVersion: "4.0.1",
              fhir: { resourceType: "DiagnosticReport" },
              downloadedAt: "2026-04-25T17:15:30.000Z",
            },
          ]
        : [],
    );

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 7,
      onProgress,
      onStage,
    });

    expect(onProgress).toHaveBeenCalledWith("Querying clinical Lab Result records...");
    expect(onProgress).toHaveBeenCalledWith("Pushing 1 clinical Lab Result record...");
    expect(onStage).toHaveBeenCalledWith({
      operation: "queryClinicalRecords",
      typeIdentifier: "HKClinicalTypeIdentifierLabResultRecord",
    });
    expect(onStage).toHaveBeenCalledWith({
      operation: "pushClinicalRecords",
      typeIdentifier: "HKClinicalTypeIdentifierLabResultRecord",
      batchIndex: 1,
      batchCount: 1,
      itemCount: 1,
    });
  });

  it("does not add clinical records to observer sync", () => {
    expect(BACKGROUND_HEALTH_KIT_TYPES).not.toContain("HKClinicalTypeIdentifierLabResultRecord");
  });

  it("uploads menstrual flow with cycle-start metadata and source identity", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const cycleStart = {
      type: "HKCategoryTypeIdentifierMenstrualFlow",
      value: 2,
      unit: "category",
      startDate: "2026-08-01T08:00:00-07:00",
      endDate: "2026-08-01T08:05:00-07:00",
      sourceName: "Cycle Source",
      sourceBundle: "com.example.cycle-source",
      uuid: "cycle-start-1",
      metadata: { HKMetadataKeyMenstrualCycleStart: true },
    };
    healthKit.queryDailyStatistics.mockResolvedValue([]);
    healthKit.queryQuantitySamples.mockResolvedValue([]);
    healthKit.queryCategorySamples.mockResolvedValue([cycleStart]);
    healthKit.queryWorkouts.mockResolvedValue([]);
    healthKit.querySleepSamples.mockResolvedValue([]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 30,
    });

    expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
      samples: [cycleStart],
    });
  });

  it("continues full sync when menstrual flow permission is not determined", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryCategorySamples.mockRejectedValue({
      code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
    });

    await expect(
      syncHealthKitToServer({ trpcClient: client, healthKit, syncRangeDays: 1 }),
    ).resolves.toEqual(expect.objectContaining({ inserted: expect.any(Number) }));
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

  it("never uploads HealthKit history from before a deleted account cutoff", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const cutoff = "2026-03-21T12:00:00.000Z";
    const sample = (uuid: string, startDate: string) => ({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: 72,
      unit: "count/min",
      startDate,
      endDate: startDate,
      sourceName: "Apple Watch",
      sourceBundle: "com.apple.health",
      uuid,
    });
    healthKit.queryDailyStatistics.mockResolvedValue([
      { date: "2026-03-21", value: 100 },
      { date: "2026-03-22", value: 200 },
    ]);
    healthKit.queryQuantitySamples.mockResolvedValue([
      sample("old", "2026-03-21T11:59:59.000Z"),
      sample("equal", cutoff),
      sample("new", "2026-03-21T12:00:00.001Z"),
    ]);
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "old-workout",
        workoutType: "running",
        startDate: cutoff,
        endDate: "2026-03-21T13:00:00.000Z",
        duration: 3600,
        totalDistance: 1000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
      {
        uuid: "new-workout",
        workoutType: "running",
        startDate: "2026-03-21T12:00:00.001Z",
        endDate: "2026-03-21T13:00:00.000Z",
        duration: 3600,
        totalDistance: 1000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
    ]);
    healthKit.querySleepSamples.mockResolvedValue([
      {
        uuid: "old-sleep",
        startDate: cutoff,
        endDate: "2026-03-21T13:00:00.000Z",
        value: "asleepCore",
        sourceName: "Apple Watch",
      },
      {
        uuid: "new-sleep",
        startDate: "2026-03-21T12:00:00.001Z",
        endDate: "2026-03-21T13:00:00.000Z",
        value: "asleepCore",
        sourceName: "Apple Watch",
      },
    ]);
    healthKit.queryWorkoutRoutes.mockResolvedValue([
      { date: cutoff, lat: 1, lng: 1 },
      { date: "2026-03-21T12:00:00.001Z", lat: 2, lng: 2 },
    ]);

    await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      minimumSampleDate: cutoff,
      syncRangeDays: null,
    });

    const quantitySamples = client.healthKitSync.pushQuantitySamples.mutate.mock.calls.flatMap(
      ([input]) => input.samples,
    );
    expect(quantitySamples.every((value) => value.startDate > cutoff)).toBe(true);
    expect(quantitySamples.some((value) => value.uuid === "new")).toBe(true);
    expect(quantitySamples.some((value) => value.startDate.startsWith("2026-03-21"))).toBe(true);
    expect(quantitySamples.some((value) => value.startDate.startsWith("2026-03-22"))).toBe(true);

    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledWith({
      workouts: [expect.objectContaining({ uuid: "new-workout" })],
      windowStart: cutoff,
      windowEnd: expect.any(String),
    });
    expect(client.healthKitSync.pushSleepSamples.mutate).toHaveBeenCalledWith({
      samples: [expect.objectContaining({ uuid: "new-sleep" })],
    });
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).toHaveBeenCalledWith({
      routes: [
        {
          workoutUuid: "new-workout",
          sourceName: "Apple Watch",
          locations: [{ date: "2026-03-21T12:00:00.001Z", lat: 2, lng: 2 }],
        },
      ],
    });
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
        workouts: expect.arrayContaining([
          expect.objectContaining({
            uuid: "workout-1",
            device: { name: "My Watch", model: "Watch7,12" },
          }),
        ]),
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

  it("does not report transient TRPC timeout wrappers during route push", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkoutRoutes.mockResolvedValue([
      { date: "2026-03-21T07:00:00Z", lat: 40.7128, lng: -74.006 },
    ]);
    const timeoutCause = new Error("fetch failed: UnexpectedException: The request timed out.");
    const trpcTimeoutError = new Error("TRPCClientError", { cause: timeoutCause });
    client.healthKitSync.pushWorkoutRoutes.mutate.mockRejectedValue(trpcTimeoutError);
    vi.mocked(captureException).mockClear();

    const result = await syncHealthKitToServer({
      trpcClient: client,
      healthKit,
      syncRangeDays: 1,
    });

    expect(result.errors.some((error) => error.includes("Push workout routes"))).toBe(true);
    expect(captureException).not.toHaveBeenCalled();
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

describe("syncHealthKitObserverChanges", () => {
  it.each(runningQuantities)(
    "applies the erasure cutoff to %s in historical and anchored sync",
    async (type, unit, value) => {
      const cutoff = "2026-10-28T10:00:00.125Z";
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const atCutoff = runningSample(type, unit, value);
      const afterCutoff = {
        ...atCutoff,
        uuid: "new-parent",
        startDate: "2026-10-28T10:00:00.875Z",
        endDate: "2026-10-28T10:00:01.000Z",
      };
      healthKit.queryDailyStatistics.mockResolvedValue([]);
      healthKit.queryQuantitySamples.mockImplementation(async (identifier) =>
        identifier === type ? [atCutoff, afterCutoff] : [],
      );
      healthKit.queryAnchoredSamples.mockResolvedValue({
        queryId: "running-query",
        samples: [atCutoff, afterCutoff],
        deletedUUIDs: [],
      });

      await syncHealthKitToServer({
        trpcClient: client,
        healthKit,
        syncRangeDays: null,
        minimumSampleDate: cutoff,
      });
      expect(healthKit.queryQuantitySamples).toHaveBeenCalledWith(type, cutoff, expect.any(String));
      expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenLastCalledWith({
        samples: [afterCutoff],
      });

      await syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: [type],
        minimumSampleDate: cutoff,
      });
      expect(healthKit.queryAnchoredSamples).toHaveBeenCalledWith(type, cutoff);
      expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenLastCalledWith({
        samples: [afterCutoff],
      });
    },
  );

  it.each(["query", "upload", "deletion"] as const)(
    "preserves the running anchor after %s failure",
    async (stage) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const type = "HKQuantityTypeIdentifierRunningSpeed";
      const error = new Error(`${stage} failed`);
      healthKit.queryAnchoredSamples.mockResolvedValue({
        queryId: "running-query",
        samples: [runningSample(type, "m/s", 3.5)],
        deletedUUIDs: ["old-parent"],
      });
      if (stage === "query") healthKit.queryAnchoredSamples.mockRejectedValue(error);
      if (stage === "upload")
        client.healthKitSync.pushQuantitySamples.mutate.mockRejectedValue(error);
      if (stage === "deletion")
        client.healthKitSync.deleteQuantitySamples.mutate.mockRejectedValue(error);

      await expect(
        syncHealthKitObserverChanges({ trpcClient: client, healthKit, typeIdentifiers: [type] }),
      ).rejects.toBe(error);

      if (stage === "query") {
        expect(healthKit.completeAnchoredQuery).not.toHaveBeenCalled();
      } else {
        expect(healthKit.completeAnchoredQuery).toHaveBeenCalledExactlyOnceWith(
          type,
          "running-query",
          false,
        );
      }
    },
  );

  it.each(runningQuantities)(
    "uploads anchored %s additions and parent deletions before acknowledgment",
    async (type, unit, value) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const sample = runningSample(type, unit, value);
      healthKit.queryAnchoredSamples.mockResolvedValue({
        queryId: "running-query",
        samples: [sample],
        deletedUUIDs: ["old-parent"],
      });

      await syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: [type],
      });

      expect(BACKGROUND_HEALTH_KIT_TYPES).toContain(type);
      expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
        samples: [sample],
      });
      expect(client.healthKitSync.deleteQuantitySamples.mutate).toHaveBeenCalledWith({
        typeIdentifier: type,
        deletedUUIDs: ["old-parent"],
      });
      expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(type, "running-query", true);
      expect(
        client.healthKitSync.pushQuantitySamples.mutate.mock.invocationCallOrder[0],
      ).toBeLessThan(healthKit.completeAnchoredQuery.mock.invocationCallOrder[0]);
      expect(
        client.healthKitSync.deleteQuantitySamples.mutate.mock.invocationCallOrder[0],
      ).toBeLessThan(healthKit.completeAnchoredQuery.mock.invocationCallOrder[0]);
    },
  );
  function createMockClient() {
    return {
      clinicalRecords: {
        push: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
      },
      healthKitSync: {
        recordSync: {
          mutate: vi.fn().mockResolvedValue({ recorded: true }),
        },
        pushQuantitySamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 1, errors: [] }),
        },
        deleteQuantitySamples: {
          mutate: vi.fn().mockResolvedValue({ deleted: 1 }),
        },
        pushRunningStepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
        pushWorkouts: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
        pushWorkoutRoutes: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
        pushSleepSamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
      },
    };
  }

  function createMockHealthKit() {
    return {
      queryClinicalRecords: vi.fn().mockResolvedValue([]),
      queryDailyStatistics: vi.fn().mockResolvedValue([]),
      queryQuantitySamples: vi.fn().mockResolvedValue([]),
      queryCategorySamples: vi.fn().mockResolvedValue([]),
      queryAnchoredSamples: vi.fn().mockResolvedValue({
        queryId: "query-1",
        samples: [
          {
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            startDate: "2026-07-27T10:00:00Z",
            endDate: "2026-07-27T10:00:05Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "heart-rate-new",
          },
        ],
        deletedUUIDs: ["heart-rate-deleted"],
      }),
      completeAnchoredQuery: vi.fn().mockResolvedValue(true),
      queryRunningStepSamples: vi.fn().mockResolvedValue({ workouts: [], samples: [] }),
      queryRunningStepChanges: vi.fn().mockResolvedValue({
        hasMore: false,
        workouts: [],
        samples: [],
        deletedUUIDs: [],
        queryId: null,
      }),
      queryWorkouts: vi.fn().mockResolvedValue([]),
      querySleepSamples: vi.fn().mockResolvedValue([]),
      queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
    };
  }

  it("uploads only anchored changes for the observed raw quantity type", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();

    const result = await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
    });

    expect(result).toEqual({ deleted: 1, errors: [], inserted: 1 });
    expect(healthKit.queryAnchoredSamples).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      expect.any(String),
    );
    expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
      samples: [expect.objectContaining({ uuid: "heart-rate-new" })],
    });
    expect(client.healthKitSync.deleteQuantitySamples.mutate).toHaveBeenCalledWith({
      deletedUUIDs: ["heart-rate-deleted"],
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
    });
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      true,
    );
    expect(
      client.healthKitSync.deleteQuantitySamples.mutate.mock.invocationCallOrder[0],
    ).toBeLessThan(healthKit.completeAnchoredQuery.mock.invocationCallOrder[0]);
    expect(healthKit.queryDailyStatistics).not.toHaveBeenCalled();
    expect(healthKit.queryQuantitySamples).not.toHaveBeenCalled();
    expect(healthKit.queryWorkouts).not.toHaveBeenCalled();
    expect(healthKit.querySleepSamples).not.toHaveBeenCalled();
  });

  it("continues later observed types when an anchored type awaits authorization", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryAnchoredSamples.mockRejectedValueOnce(
      Object.assign(new Error("localized system message"), {
        code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
      }),
    );

    const result = await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKQuantityTypeIdentifierBodyMass", "HKQuantityTypeIdentifierHeartRate"],
    });

    expect(result).toEqual({ deleted: 1, errors: [], inserted: 1 });
    expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
      samples: [expect.objectContaining({ uuid: "heart-rate-new" })],
    });
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledExactlyOnceWith(
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      true,
    );
  });

  it.each(["HKQuantityTypeIdentifierBodyMass", MENSTRUAL_FLOW_TYPE_IDENTIFIER])(
    "preserves the anchor for %s until authorization completes",
    async (typeIdentifier) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      healthKit.queryAnchoredSamples.mockRejectedValueOnce({
        code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
      });
      const options = { trpcClient: client, healthKit, typeIdentifiers: [typeIdentifier] };

      expect(await syncHealthKitObserverChanges(options)).toEqual({
        deleted: 0,
        errors: [],
        inserted: 0,
      });
      expect(healthKit.completeAnchoredQuery).not.toHaveBeenCalled();
      expect(client.healthKitSync.pushQuantitySamples.mutate).not.toHaveBeenCalled();
      expect(client.healthKitSync.deleteQuantitySamples.mutate).not.toHaveBeenCalled();

      healthKit.queryAnchoredSamples.mockResolvedValue({
        queryId: "query-authorized",
        samples: [
          {
            type: typeIdentifier,
            value: 2,
            unit: "count",
            startDate: "2026-07-27T10:00:00Z",
            endDate: "2026-07-27T10:00:00Z",
            sourceName: "Health source",
            sourceBundle: "com.example.health",
            uuid: "sample-authorized",
          },
        ],
        deletedUUIDs: [],
      });

      expect(await syncHealthKitObserverChanges(options)).toEqual({
        deleted: 0,
        errors: [],
        inserted: 1,
      });
      expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
        samples: [expect.objectContaining({ type: typeIdentifier, uuid: "sample-authorized" })],
      });
      expect(healthKit.completeAnchoredQuery).toHaveBeenCalledExactlyOnceWith(
        typeIdentifier,
        "query-authorized",
        true,
      );
    },
  );

  it.each(["QUERY_ERROR", "HEALTHKIT_DATABASE_INACCESSIBLE", undefined])(
    "propagates anchored query errors with code %s",
    async (code) => {
      const client = createMockClient();
      const healthKit = createMockHealthKit();
      const error = Object.assign(new Error("Authorization not determined"), { code });
      healthKit.queryAnchoredSamples.mockRejectedValue(error);

      await expect(
        syncHealthKitObserverChanges({
          trpcClient: client,
          healthKit,
          typeIdentifiers: ["HKQuantityTypeIdentifierBodyMass"],
        }),
      ).rejects.toBe(error);
      expect(healthKit.completeAnchoredQuery).not.toHaveBeenCalled();
    },
  );

  it("uploads and deletes menstrual flow through the anchored observer path", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const cycleStart = {
      type: MENSTRUAL_FLOW_TYPE_IDENTIFIER,
      value: 2,
      unit: "category",
      startDate: "2026-08-01T08:00:00-07:00",
      endDate: "2026-08-01T08:05:00-07:00",
      sourceName: "Cycle Source",
      sourceBundle: "com.example.cycle-source",
      uuid: "cycle-start-new",
      metadata: { HKMetadataKeyMenstrualCycleStart: true },
    };
    healthKit.queryAnchoredSamples.mockResolvedValue({
      queryId: "query-cycle",
      samples: [cycleStart],
      deletedUUIDs: ["cycle-start-deleted"],
    });

    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: [MENSTRUAL_FLOW_TYPE_IDENTIFIER],
    });

    expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
      samples: [cycleStart],
    });
    expect(client.healthKitSync.deleteQuantitySamples.mutate).toHaveBeenCalledWith({
      deletedUUIDs: ["cycle-start-deleted"],
      typeIdentifier: MENSTRUAL_FLOW_TYPE_IDENTIFIER,
    });
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      MENSTRUAL_FLOW_TYPE_IDENTIFIER,
      "query-cycle",
      true,
    );
  });

  it("never uploads observer samples at or before the device erasure cutoff", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const cutoff = "2026-07-27T10:00:00.000Z";
    healthKit.queryAnchoredSamples.mockResolvedValue({
      queryId: "query-cutoff",
      samples: [
        {
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 70,
          unit: "count/min",
          startDate: cutoff,
          endDate: "2026-07-27T10:00:05.000Z",
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
          uuid: "heart-rate-at-cutoff",
        },
        {
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 72,
          unit: "count/min",
          startDate: "2026-07-27T10:00:01.000Z",
          endDate: "2026-07-27T10:00:06.000Z",
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
          uuid: "heart-rate-after-cutoff",
        },
      ],
      deletedUUIDs: [],
    });

    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      minimumSampleDate: cutoff,
      typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
    });

    expect(healthKit.queryAnchoredSamples).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      cutoff,
    );
    expect(client.healthKitSync.pushQuantitySamples.mutate).toHaveBeenCalledWith({
      samples: [expect.objectContaining({ uuid: "heart-rate-after-cutoff" })],
    });
    expect(client.healthKitSync.pushQuantitySamples.mutate).not.toHaveBeenCalledWith({
      samples: [expect.objectContaining({ uuid: "heart-rate-at-cutoff" })],
    });
  });

  it("batches anchored deletions to the server endpoint limit before committing", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryAnchoredSamples.mockResolvedValue({
      queryId: "query-many-deletions",
      samples: [],
      deletedUUIDs: Array.from({ length: 501 }, (_, index) => `deleted-${index}`),
    });
    client.healthKitSync.deleteQuantitySamples.mutate.mockImplementation(
      async ({ deletedUUIDs }) => ({ deleted: deletedUUIDs.length }),
    );

    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
    });

    expect(client.healthKitSync.deleteQuantitySamples.mutate).toHaveBeenCalledTimes(2);
    expect(
      client.healthKitSync.deleteQuantitySamples.mutate.mock.calls.map(
        ([input]) => input.deletedUUIDs.length,
      ),
    ).toEqual([500, 1]);
    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      "query-many-deletions",
      true,
    );
  });

  it("fails the observer sync when the native anchor commit is rejected", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.completeAnchoredQuery.mockResolvedValue(false);

    await expect(
      syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
      }),
    ).rejects.toThrow(
      "HealthKit anchor commit rejected for HKQuantityTypeIdentifierHeartRate (query query-1)",
    );

    expect(healthKit.completeAnchoredQuery).toHaveBeenNthCalledWith(
      1,
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      true,
    );
    expect(healthKit.completeAnchoredQuery).toHaveBeenNthCalledWith(
      2,
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      false,
    );
  });

  it("batches observer workout routes into one server mutation", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "workout-1",
        workoutType: "running",
        startDate: "2026-07-27T10:00:00Z",
        endDate: "2026-07-27T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        device: { name: "My Watch", model: "Watch7,12" },
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
      {
        uuid: "workout-2",
        workoutType: "cycling",
        startDate: "2026-07-27T12:00:00Z",
        endDate: "2026-07-27T13:00:00Z",
        duration: 3600,
        totalDistance: 20000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
    ]);
    healthKit.queryWorkoutRoutes.mockImplementation(async (workoutUuid) => [
      {
        date: "2026-07-27T10:00:00Z",
        lat: workoutUuid === "workout-1" ? 1 : 2,
        lng: 3,
      },
    ]);
    client.healthKitSync.pushWorkoutRoutes.mutate.mockResolvedValue({ inserted: 2 });

    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKWorkoutTypeIdentifier"],
    });

    expect(client.healthKitSync.pushWorkoutRoutes.mutate).toHaveBeenCalledTimes(1);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workouts: expect.arrayContaining([
          expect.objectContaining({
            uuid: "workout-1",
            device: { name: "My Watch", model: "Watch7,12" },
          }),
        ]),
      }),
    );
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).toHaveBeenCalledWith({
      routes: [
        expect.objectContaining({ workoutUuid: "workout-1" }),
        expect.objectContaining({ workoutUuid: "workout-2" }),
      ],
    });
  });

  it("keeps per-workout observer route query failures isolated", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const routeError = new Error("route unavailable");
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "workout-failed",
        workoutType: "running",
        startDate: "2026-07-27T10:00:00Z",
        endDate: "2026-07-27T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
      {
        uuid: "workout-succeeded",
        workoutType: "cycling",
        startDate: "2026-07-27T12:00:00Z",
        endDate: "2026-07-27T13:00:00Z",
        duration: 3600,
        totalDistance: 20000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
    ]);
    healthKit.queryWorkoutRoutes.mockImplementation(async (workoutUuid) => {
      if (workoutUuid === "workout-failed") {
        throw routeError;
      }
      return [{ date: "2026-07-27T12:00:00Z", lat: 1, lng: 2 }];
    });

    const result = await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKWorkoutTypeIdentifier"],
    });

    expect(result.errors).toEqual(["Route sync for workout workout-failed: route unavailable"]);
    expect(client.healthKitSync.pushWorkoutRoutes.mutate).toHaveBeenCalledWith({
      routes: [expect.objectContaining({ workoutUuid: "workout-succeeded" })],
    });
    expect(captureException).toHaveBeenCalledWith(routeError, {
      source: "health-kit-workout-route-observer-sync",
      workoutUuid: "workout-failed",
    });
  });

  it("reports a failed observer route batch without counting its rows", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const routePushError = new Error("route push failed");
    healthKit.queryWorkouts.mockResolvedValue([
      {
        uuid: "workout-1",
        workoutType: "running",
        startDate: "2026-07-27T10:00:00Z",
        endDate: "2026-07-27T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
        sourceBundle: "com.apple.health",
      },
    ]);
    healthKit.queryWorkoutRoutes.mockResolvedValue([
      { date: "2026-07-27T10:00:00Z", lat: 1, lng: 2 },
    ]);
    client.healthKitSync.pushWorkoutRoutes.mutate.mockRejectedValue(routePushError);

    const result = await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKWorkoutTypeIdentifier"],
    });

    expect(result).toEqual({
      deleted: 0,
      errors: ["Push workout routes: route push failed"],
      inserted: 0,
    });
    expect(captureException).toHaveBeenCalledWith(routePushError, {
      routeCount: 1,
      source: "health-kit-workout-route-observer-push",
    });
  });

  it("queries only the observed additive type's bounded daily statistics", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    healthKit.queryDailyStatistics.mockResolvedValue([{ date: "2026-07-27", value: 1234 }]);

    await syncHealthKitObserverChanges({
      trpcClient: client,
      healthKit,
      typeIdentifiers: ["HKQuantityTypeIdentifierStepCount"],
    });

    expect(healthKit.queryDailyStatistics).toHaveBeenCalledTimes(1);
    expect(healthKit.queryDailyStatistics).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      expect.any(String),
      expect.any(String),
    );
    expect(healthKit.queryAnchoredSamples).not.toHaveBeenCalled();
    expect(healthKit.queryQuantitySamples).not.toHaveBeenCalled();
    expect(healthKit.queryWorkouts).not.toHaveBeenCalled();
    expect(healthKit.querySleepSamples).not.toHaveBeenCalled();
  });

  it("does not commit an anchor when the server upload fails", async () => {
    const client = createMockClient();
    const healthKit = createMockHealthKit();
    const uploadError = new Error("network failed");
    client.healthKitSync.pushQuantitySamples.mutate.mockRejectedValue(uploadError);

    await expect(
      syncHealthKitObserverChanges({
        trpcClient: client,
        healthKit,
        typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
      }),
    ).rejects.toThrow(uploadError);

    expect(healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      false,
    );
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
