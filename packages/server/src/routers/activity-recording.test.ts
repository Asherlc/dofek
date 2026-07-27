import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

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

function makeMetricStreamPublisher() {
  return {
    publishRows: vi.fn(async (rows: readonly Record<string, unknown>[]) =>
      rows.map((row, index) => ({
        version: 1,
        id: `event-${index}`,
        recordedAt:
          row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt),
      })),
    ),
  };
}

function makeExecute() {
  // Drizzle execute returns an array-like QueryResult;
  // for RETURNING queries the result is an array of row objects.
  return vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: "test-activity-id" }])
    .mockResolvedValue([]);
}

function makeCaller(execute: ReturnType<typeof makeExecute>) {
  const metricStreamPublisher = makeMetricStreamPublisher();
  const caller = createCaller({
    db: makeTransactionalTestDatabase({ execute }),
    metricStreamPublisher,
    userId: "user-1",
  });
  return { caller, metricStreamPublisher };
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
      const { caller, metricStreamPublisher } = makeCaller(execute);

      const result = await caller.save(makeValidInput());

      expect(result).toEqual({ activityId: expect.any(String) });
      expect(execute).toHaveBeenCalledTimes(4);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(6);
    });

    it("generates a deterministic external ID (same input = same call)", async () => {
      const execute1 = makeExecute();
      const execute2 = makeExecute();

      const { caller: caller1, metricStreamPublisher: publisher1 } = makeCaller(execute1);
      const { caller: caller2, metricStreamPublisher: publisher2 } = makeCaller(execute2);

      const input = makeValidInput();
      await caller1.save(input);
      await caller2.save(input);

      // Both calls should produce identical SQL (same external ID for same input)
      expect(execute1.mock.calls.length).toBe(execute2.mock.calls.length);
      expect(publisher1.publishRows.mock.calls[0]?.[0]).toEqual(
        publisher2.publishRows.mock.calls[0]?.[0],
      );
    });

    it("writes deterministic sample external IDs in published events", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

      await caller.save(makeValidInput());

      const serializedStatements = execute.mock.calls.map((call) => JSON.stringify(call[0]));
      const publishedRows = metricStreamPublisher.publishRows.mock.calls[0]?.[0] ?? [];

      expect(serializedStatements.some((statement) => statement.includes("external_id"))).toBe(
        true,
      );
      expect(
        publishedRows.some(
          (row) =>
            row.externalId ===
            "dofek:2024-06-15T08:00:00.000Z:user-1:location:2024-06-15T08:00:00.000Z",
        ),
      ).toBe(true);
      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
    });

    it("handles empty samples array", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

      const result = await caller.save(makeValidInput({ samples: [] }));

      expect(result).toEqual({ activityId: expect.any(String) });
      // Should still insert the activity (just no metric_stream rows)
      expect(execute).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    });

    it("allows null optional fields", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

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
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    });

    it("rejects invalid activity type (empty string)", async () => {
      const execute = makeExecute();
      const { caller } = makeCaller(execute);

      await expect(caller.save(makeValidInput({ activityType: "" }))).rejects.toThrow();
    });

    it("rejects missing required fields", async () => {
      const execute = makeExecute();
      const { caller } = makeCaller(execute);

      await expect(caller.save({ activityType: "running" })).rejects.toThrow();
    });

    it("inserts samples in batches", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

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
      expect(execute).toHaveBeenCalledTimes(6);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(1500);
      expect(metricStreamPublisher.publishRows.mock.calls[1]?.[0]).toHaveLength(300);
    });
  });
});
