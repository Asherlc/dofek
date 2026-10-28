import { describe, expect, it, vi } from "vitest";
import { syncRunningSteps } from "./health-kit-running-steps-sync";
import type { ObserverSyncOptions } from "./health-kit-sync";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

function options() {
  return {
    typeIdentifiers: ["HKQuantityTypeIdentifierStepCount"],
    healthKit: {
      queryRunningStepSamples: vi.fn().mockResolvedValue({ workouts: [], samples: [] }),
      queryRunningStepChanges: vi.fn().mockResolvedValue({
        hasMore: false,
        workouts: [],
        samples: [],
        deletedUUIDs: [],
        queryId: null,
      }),
      completeAnchoredQuery: vi.fn().mockResolvedValue(true),
      queryAnchoredSamples: vi.fn(),
      queryDailyStatistics: vi.fn(),
      queryQuantitySamples: vi.fn(),
      queryCategorySamples: vi.fn(),
      queryClinicalRecords: vi.fn(),
      queryWorkouts: vi.fn(),
      querySleepSamples: vi.fn(),
      queryWorkoutRoutes: vi.fn(),
    },
    trpcClient: {
      clinicalRecords: { push: { mutate: vi.fn() } },
      healthKitSync: {
        pushRunningStepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
        deleteQuantitySamples: { mutate: vi.fn().mockResolvedValue({ deleted: 1 }) },
        recordSync: { mutate: vi.fn() },
        pushQuantitySamples: { mutate: vi.fn() },
        pushWorkouts: { mutate: vi.fn() },
        pushWorkoutRoutes: { mutate: vi.fn() },
        pushSleepSamples: { mutate: vi.fn() },
      },
    },
  } satisfies ObserverSyncOptions;
}
const start = "2026-10-20T00:00:00Z";
const end = "2026-10-21T00:00:00Z";

describe("syncRunningSteps", () => {
  it("drains a full unmatched parent page before uploading the next associated page", async () => {
    const input = options();
    const order: string[] = [];
    input.healthKit.queryRunningStepChanges
      .mockResolvedValueOnce({
        workouts: [],
        samples: [],
        deletedUUIDs: [],
        queryId: "first",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        workouts: [{ uuid: "run" }],
        samples: [{ uuid: "parent", workoutUuids: ["run"] }],
        deletedUUIDs: [],
        queryId: "second",
        hasMore: false,
      });
    input.trpcClient.healthKitSync.pushRunningStepSamples.mutate.mockImplementation(async () => {
      order.push("upload");
      return { inserted: 1 };
    });
    input.healthKit.completeAnchoredQuery.mockImplementation(async (_type, queryId) => {
      order.push(`commit:${queryId}`);
      return true;
    });
    expect(await syncRunningSteps(input, start, end)).toEqual({
      inserted: 1,
      deleted: 0,
      errors: [],
    });
    expect(input.healthKit.queryRunningStepChanges).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["commit:first", "upload", "commit:second"]);
  });

  it("preserves the successful page cursor when the subsequent page fails acknowledgment", async () => {
    const input = options();
    let committedCursor = "original";
    input.healthKit.queryRunningStepChanges
      .mockResolvedValueOnce({
        workouts: [],
        samples: [],
        deletedUUIDs: [],
        queryId: "first",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        workouts: [],
        samples: [],
        deletedUUIDs: ["deleted"],
        queryId: "second",
        hasMore: false,
      });
    input.healthKit.completeAnchoredQuery.mockImplementation(async (_type, queryId, succeeded) => {
      if (queryId === "second" && succeeded) return false;
      if (succeeded) committedCursor = queryId;
      return true;
    });
    await expect(syncRunningSteps(input, start, end)).rejects.toThrow(/commit rejected/i);
    expect(committedCursor).toBe("first");
    expect(input.healthKit.completeAnchoredQuery).toHaveBeenLastCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      "second",
      false,
    );
  });

  it("fails a full page without a native continuation anchor", async () => {
    const input = options();
    input.healthKit.queryRunningStepChanges.mockResolvedValueOnce({
      workouts: [],
      samples: [],
      deletedUUIDs: [],
      queryId: null,
      hasMore: true,
    });
    await expect(syncRunningSteps(input, start, end)).rejects.toThrow(
      /missing its continuation anchor/i,
    );
    expect(input.healthKit.queryRunningStepChanges).toHaveBeenCalledTimes(1);
    expect(input.healthKit.completeAnchoredQuery).not.toHaveBeenCalled();
  });

  it("uploads additions and all parent deletion batches before committing the step anchor", async () => {
    const input = options();
    const order: string[] = [];
    input.healthKit.queryRunningStepChanges.mockResolvedValue({
      hasMore: false,
      workouts: [{ uuid: "run" }],
      samples: [{ uuid: "parent", workoutUuids: ["run"] }],
      deletedUUIDs: Array.from({ length: 501 }, (_, index) => `deleted-${index}`),
      queryId: "pending",
    });
    input.trpcClient.healthKitSync.pushRunningStepSamples.mutate.mockImplementation(async () => {
      order.push("upload");
      return { inserted: 1 };
    });
    input.trpcClient.healthKitSync.deleteQuantitySamples.mutate.mockImplementation(async () => {
      order.push("delete");
      return { deleted: 1 };
    });
    input.healthKit.completeAnchoredQuery.mockImplementation(async () => {
      order.push("commit");
      return true;
    });
    expect(await syncRunningSteps(input, start, end)).toEqual({
      inserted: 1,
      deleted: 2,
      errors: [],
    });
    expect(order).toEqual(["upload", "delete", "delete", "commit"]);
    expect(
      input.trpcClient.healthKitSync.deleteQuantitySamples.mutate.mock.calls.map(
        ([payload]) => payload.deletedUUIDs.length,
      ),
    ).toEqual([500, 1]);
    expect(input.healthKit.completeAnchoredQuery).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      "pending",
      true,
    );
  });

  it("stops before reading a delta when a snapshot upload fails", async () => {
    const input = options();
    input.healthKit.queryRunningStepSamples.mockResolvedValue({
      workouts: [{ uuid: "run" }],
      samples: [{ uuid: "parent", workoutUuids: ["run"] }],
    });
    const failure = new Error("Upload failed");
    input.trpcClient.healthKitSync.pushRunningStepSamples.mutate.mockRejectedValue(failure);
    await expect(syncRunningSteps(input, start, end)).rejects.toBe(failure);
    expect(input.healthKit.queryRunningStepChanges).not.toHaveBeenCalled();
    expect(input.healthKit.completeAnchoredQuery).not.toHaveBeenCalled();
  });

  it("rejects unsuccessful native anchor completion and discards the pending query", async () => {
    const input = options();
    input.healthKit.queryRunningStepChanges.mockResolvedValue({
      hasMore: false,
      workouts: [],
      samples: [],
      deletedUUIDs: ["parent"],
      queryId: "pending",
    });
    input.healthKit.completeAnchoredQuery.mockResolvedValue(false);
    await expect(syncRunningSteps(input, start, end)).rejects.toThrow(/commit rejected/i);
    expect(input.healthKit.completeAnchoredQuery).toHaveBeenLastCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      "pending",
      false,
    );
  });
});
