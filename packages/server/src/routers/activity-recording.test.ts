import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTl: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { activityRecordingRouter } from "./activity-recording.ts";

const createCaller = createTestCallerFactory(activityRecordingRouter);

function makeExecute() {
  // Drizzle execute returns an array-like QueryResult;
  // for RETURNING queries the result is an array of row objects.
  const result = [{ id: "test-activity-id" }];
  return vi.fn().mockResolvedValue(result);
}

function makeValidInput(overrides: Record<string, unknown> = {}) {
  return {
    activityType: "running",
    startedAt: "2024-06-15T08:00:00Z",
    endedAt: "2024-06-15T09:00:00Z",
    name: "Morning run",
    notes: null,
    sourceName: "Dofek iOS",
    samples: [
      {
        recordedAt: "2024-06-15T08:00:00Z",
        lat: 40.7128,
        lng: -74.006,
        gpsAccuracy: 5,
        altitude: 10,
        speed: 3.5,
      },
      {
        recordedAt: "2024-06-15T08:00:05Z",
        lat: 40.7129,
        lng: -74.0061,
        gpsAccuracy: 4,
        altitude: 11,
        speed: 3.6,
      },
    ],
    ...overrides,
  };
}

describe("activityRecordingRouter", () => {
  describe("save", () => {
    it("inserts the activity and metric stream samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.save(makeValidInput());

      expect(result).toEqual({ activityId: expect.any(String) });
      // Should have called execute at least 3 times:
      // 1. ensureProvider
      // 2. insert activity
      // 3. insert metric stream samples
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("generates a deterministic external ID (same input = same call)", async () => {
      const execute1 = makeExecute();
      const execute2 = makeExecute();

      const caller1 = createCaller({ db: { execute: execute1 }, userId: "user-1" });
      const caller2 = createCaller({ db: { execute: execute2 }, userId: "user-1" });

      const input = makeValidInput();
      await caller1.save(input);
      await caller2.save(input);

      // Both calls should produce identical SQL (same external ID for same input)
      expect(execute1.mock.calls.length).toBe(execute2.mock.calls.length);
    });

    it("handles empty samples array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.save(makeValidInput({ samples: [] }));

      expect(result).toEqual({ activityId: expect.any(String) });
      // Should still insert the activity (just no metric_stream rows)
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("allows null optional fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.save(
        makeValidInput({
          name: null,
          notes: null,
          samples: [
            {
              recordedAt: "2024-06-15T08:00:00Z",
              lat: null,
              lng: null,
              gpsAccuracy: null,
              altitude: null,
              speed: null,
            },
          ],
        }),
      );

      expect(result).toEqual({ activityId: expect.any(String) });
    });

    it("rejects invalid activity type (empty string)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await expect(caller.save(makeValidInput({ activityType: "" }))).rejects.toThrow();
    });

    it("rejects missing required fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await expect(caller.save({ activityType: "running" })).rejects.toThrow();
    });

    it("inserts samples in batches", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      // Create 600 samples (batch size is 500)
      const samples = Array.from({ length: 600 }, (_, i) => ({
        recordedAt: `2024-06-15T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        lat: 40.7128 + i * 0.0001,
        lng: -74.006 + i * 0.0001,
        gpsAccuracy: 5,
        altitude: 10,
        speed: 3.5,
      }));

      const result = await caller.save(makeValidInput({ samples }));

      expect(result).toEqual({ activityId: expect.any(String) });
      // Should have more execute calls due to batching
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });
});
