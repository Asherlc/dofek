import { describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../routers/test-helpers.ts";
import type { SaveActivityInput } from "./activity-recording-repository.ts";
import { ActivityRecordingRepository } from "./activity-recording-repository.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

describe("ActivityRecordingRepository", () => {
  function makePublisher() {
    return {
      publishRows: vi.fn(async (rows: readonly unknown[]) =>
        rows.map((_, index) => ({ id: `event-${index}` })),
      ),
    };
  }

  function makeRepository(executeResults?: Record<string, unknown>[][]) {
    const execute = vi.fn().mockResolvedValue([]);
    if (executeResults) {
      for (const result of executeResults) {
        execute.mockResolvedValueOnce(result);
      }
    } else {
      // Default: ensureProvider returns nothing, insert returns an id
      execute.mockResolvedValueOnce([]); // ensureProvider
      execute.mockResolvedValueOnce([{ id: "activity-123" }]); // INSERT RETURNING
    }
    const db = makeTransactionalTestDatabase({ execute });
    const publisher = makePublisher();
    const repository = new ActivityRecordingRepository(
      db,
      "00000000-0000-0000-0000-000000000001",
      publisher,
    );
    return { repository, execute, publisher };
  }

  function makeInput(overrides: Partial<SaveActivityInput> = {}): SaveActivityInput {
    return {
      activityType: "running",
      startedAt: "2024-06-15T08:00:00Z",
      endedAt: "2024-06-15T09:00:00Z",
      name: "Morning Run",
      notes: null,
      sourceName: "dofek-mobile",
      samples: [],
      ...overrides,
    };
  }

  describe("ensureProvider", () => {
    it("executes an INSERT for the dofek provider", async () => {
      const { repository, execute } = makeRepository([[]]);
      await repository.ensureProvider();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveActivity", () => {
    it("returns the activity id", async () => {
      const { repository } = makeRepository();
      const activityId = await repository.saveActivity(makeInput());
      expect(activityId).toBe("activity-123");
    });

    it("calls ensureProvider before inserting", async () => {
      const { repository, execute } = makeRepository();
      await repository.saveActivity(makeInput());
      // First call is ensureProvider, second is INSERT RETURNING
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("throws when insert returns no rows", async () => {
      const { repository } = makeRepository([
        [], // ensureProvider
        [], // INSERT returns nothing
      ]);
      await expect(repository.saveActivity(makeInput())).rejects.toThrow(
        "Failed to insert activity",
      );
    });

    it("publishes GPS samples", async () => {
      const samples = Array.from({ length: 3 }, (_, index) => ({
        recordedAt: `2024-06-15T08:0${index}:00Z`,
        lat: 32.0 + index * 0.001,
        lng: 34.0 + index * 0.001,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute, publisher } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-456" }], // INSERT RETURNING
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-456");
      expect(execute).toHaveBeenCalledTimes(4);
      expect(publisher.publishRows).toHaveBeenCalledTimes(1);
      const publishedRows = publisher.publishRows.mock.calls[0]?.[0] ?? [];
      expect(publishedRows).toHaveLength(9);
      expect(publishedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "location",
            point: "SRID=4326;POINT(34 32)",
            metadata: { horizontal_accuracy_m: 5 },
          }),
          expect.objectContaining({ channel: "altitude", scalar: 100 }),
          expect.objectContaining({ channel: "speed", scalar: 3.5 }),
        ]),
      );
    });

    it("handles samples exceeding batch size with multiple publish batches", async () => {
      // Create 501 samples to trigger 2 batches (500 + 1)
      const samples = Array.from({ length: 501 }, (_, index) => ({
        recordedAt: `2024-06-15T08:00:00.${String(index).padStart(3, "0")}Z`,
        lat: 32.0,
        lng: 34.0,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute, publisher } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-789" }], // INSERT RETURNING
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-789");
      expect(execute).toHaveBeenCalledTimes(6);
      expect(publisher.publishRows).toHaveBeenCalledTimes(2);
      expect(publisher.publishRows.mock.calls[0]?.[0]).toHaveLength(1500);
      expect(publisher.publishRows.mock.calls[1]?.[0]).toHaveLength(3);
    });

    it("creates exactly 1 publish batch for 500 samples (boundary)", async () => {
      const samples = Array.from({ length: 500 }, (_, index) => ({
        recordedAt: `2024-06-15T08:00:00.${String(index).padStart(3, "0")}Z`,
        lat: 32.0,
        lng: 34.0,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute, publisher } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-batch" }], // INSERT RETURNING
      ]);

      await repository.saveActivity(makeInput({ samples }));
      expect(execute).toHaveBeenCalledTimes(4);
      expect(publisher.publishRows).toHaveBeenCalledTimes(1);
      expect(publisher.publishRows.mock.calls[0]?.[0]).toHaveLength(1500);
    });

    it("handles samples with null values", async () => {
      const samples = [
        {
          recordedAt: "2024-06-15T08:00:00Z",
          lat: null,
          lng: null,
          gpsAccuracy: null,
          altitude: null,
          speed: null,
        },
      ];

      const { repository, execute, publisher } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-null" }], // INSERT RETURNING
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-null");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(publisher.publishRows).not.toHaveBeenCalled();
    });

    it("publishes GPS samples through Redpanda without inserting metric stream rows into Postgres", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "activity-456" }]);
      const publisher = makePublisher();
      const repository = new ActivityRecordingRepository(
        makeTransactionalTestDatabase({ execute }),
        "00000000-0000-0000-0000-000000000001",
        publisher,
      );

      await repository.saveActivity(
        makeInput({
          samples: [
            {
              recordedAt: "2024-06-15T08:00:00Z",
              lat: 32,
              lng: 34,
              gpsAccuracy: 5,
              altitude: 100,
              speed: 3.5,
            },
          ],
        }),
      );

      expect(execute).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
      expect(publisher.publishRows).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            channel: "location",
            point: "SRID=4326;POINT(34 32)",
          }),
          expect.objectContaining({ channel: "altitude", scalar: 100 }),
          expect.objectContaining({ channel: "speed", scalar: 3.5 }),
        ],
        { operationRevision: "1000000000000000" },
      );
    });
  });
});
