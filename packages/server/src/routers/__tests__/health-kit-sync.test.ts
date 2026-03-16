import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { healthKitSyncRouter } from "../health-kit-sync.ts";

const createCaller = createTestCallerFactory(healthKitSyncRouter);

function makeExecute() {
  return vi.fn().mockResolvedValue([]);
}

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    type: "HKQuantityTypeIdentifierStepCount",
    value: 1000,
    unit: "count",
    startDate: "2024-01-15T10:00:00Z",
    endDate: "2024-01-15T10:30:00Z",
    sourceName: "iPhone",
    sourceBundle: "com.apple.Health",
    uuid: "test-uuid-001",
    ...overrides,
  };
}

describe("healthKitSyncRouter", () => {
  describe("pushQuantitySamples", () => {
    it("processes body measurement samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "body-1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it("processes additive daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "s1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierActiveEnergyBurned",
            value: 300,
            uuid: "s2",
          }),
        ],
      });

      expect(result.inserted).toBe(2);
      expect(result.errors).toEqual([]);
    });

    it("processes point-in-time daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierRestingHeartRate", value: 55, uuid: "rhr1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 65,
            uuid: "hrv1",
          }),
        ],
      });

      expect(result.inserted).toBe(2);
    });

    it("processes metric stream samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 120, uuid: "hr1" }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("processes health event samples (catch-all)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierUnknownType", value: 1, uuid: "he1" }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty samples array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({ samples: [] });

      expect(result.inserted).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("applies body fat percentage transform", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.15,
            uuid: "bf1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("reports errors when processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // body measurements fail
      execute.mockRejectedValueOnce(new Error("DB connection failed"));

      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierBodyMass", value: 75, uuid: "err1" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Body measurements");
    });

    it("applies distance transform (m to km)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "dist1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });
  });

  describe("pushWorkouts", () => {
    it("processes workout samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w1",
            workoutType: "13", // cycling
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("maps unknown workout type to other", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w2",
            workoutType: "999",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T10:30:00Z",
            duration: 1800,
            totalEnergyBurned: null,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty workouts array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushWorkouts({ workouts: [] });
      expect(result.inserted).toBe(0);
    });
  });

  describe("pushSleepSamples", () => {
    it("processes sleep session with stages", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-1",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-1",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-15T23:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-2",
            startDate: "2024-01-15T23:30:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-3",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T04:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-4",
            startDate: "2024-01-16T04:00:00Z",
            endDate: "2024-01-16T04:15:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("returns 0 when no inBed samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "stage-only",
            startDate: "2024-01-15T23:00:00Z",
            endDate: "2024-01-15T23:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(0);
    });
  });
});
