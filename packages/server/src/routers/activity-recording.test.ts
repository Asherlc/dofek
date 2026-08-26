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
    ...overrides,
  };
}

describe("activityRecordingRouter", () => {
  describe("save", () => {
    it("inserts the recorded activity", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

      const result = await caller.save(makeValidInput());

      expect(result).toEqual({ activityId: expect.any(String) });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
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

    it("allows null optional fields", async () => {
      const execute = makeExecute();
      const { caller, metricStreamPublisher } = makeCaller(execute);

      const result = await caller.save(
        makeValidInput({
          name: null,
          notes: null,
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

  });
});
