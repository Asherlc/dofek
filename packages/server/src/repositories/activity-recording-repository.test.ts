import { describe, expect, it, vi } from "vitest";
import type { SaveActivityInput } from "./activity-recording-repository.ts";
import { ActivityRecordingRepository } from "./activity-recording-repository.ts";

describe("ActivityRecordingRepository", () => {
  function makeRepository(executeResults?: Record<string, unknown>[][]) {
    const execute = vi.fn();
    if (executeResults) {
      for (const result of executeResults) {
        execute.mockResolvedValueOnce(result);
      }
    } else {
      // Default: ensureProvider returns nothing, insert returns an id
      execute.mockResolvedValueOnce([]); // ensureProvider
      execute.mockResolvedValueOnce([{ id: "activity-123" }]); // INSERT RETURNING
    }
    const db = { execute };
    const repository = new ActivityRecordingRepository(db, "user-1");
    return { repository, execute };
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

    it("batch-inserts GPS samples", async () => {
      const samples = Array.from({ length: 3 }, (_, index) => ({
        recordedAt: `2024-06-15T08:0${index}:00Z`,
        lat: 32.0 + index * 0.001,
        lng: 34.0 + index * 0.001,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-456" }], // INSERT RETURNING
        [], // sensor_sample: lat
        [], // sensor_sample: lng
        [], // sensor_sample: gps_accuracy
        [], // sensor_sample: altitude
        [], // sensor_sample: speed
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-456");
      // ensureProvider + INSERT activity + 5 sensor_sample channels
      expect(execute).toHaveBeenCalledTimes(7);
    });

    it("handles samples exceeding batch size with multiple batches", async () => {
      // Create 501 samples to trigger 2 batches (500 + 1)
      const samples = Array.from({ length: 501 }, (_, index) => ({
        recordedAt: `2024-06-15T08:00:00.${String(index).padStart(3, "0")}Z`,
        lat: 32.0,
        lng: 34.0,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-789" }], // INSERT RETURNING
        [], // batch 1: sensor_sample lat
        [], // batch 1: sensor_sample lng
        [], // batch 1: sensor_sample gps_accuracy
        [], // batch 1: sensor_sample altitude
        [], // batch 1: sensor_sample speed
        [], // batch 2: sensor_sample lat
        [], // batch 2: sensor_sample lng
        [], // batch 2: sensor_sample gps_accuracy
        [], // batch 2: sensor_sample altitude
        [], // batch 2: sensor_sample speed
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-789");
      // ensureProvider + INSERT activity + 2 batches × 5 sensor_sample channels
      expect(execute).toHaveBeenCalledTimes(12);
    });

    it("creates exactly 1 batch for 500 samples (boundary)", async () => {
      const samples = Array.from({ length: 500 }, (_, index) => ({
        recordedAt: `2024-06-15T08:00:00.${String(index).padStart(3, "0")}Z`,
        lat: 32.0,
        lng: 34.0,
        gpsAccuracy: 5,
        altitude: 100,
        speed: 3.5,
      }));

      const { repository, execute } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-batch" }], // INSERT RETURNING
        [], // sensor_sample: lat
        [], // sensor_sample: lng
        [], // sensor_sample: gps_accuracy
        [], // sensor_sample: altitude
        [], // sensor_sample: speed
      ]);

      await repository.saveActivity(makeInput({ samples }));
      // ensureProvider + INSERT activity + 5 sensor_sample channels
      expect(execute).toHaveBeenCalledTimes(7);
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

      const { repository, execute } = makeRepository([
        [], // ensureProvider
        [{ id: "activity-null" }], // INSERT RETURNING
      ]);

      const activityId = await repository.saveActivity(makeInput({ samples }));
      expect(activityId).toBe("activity-null");
      // ensureProvider + INSERT activity (all GPS values null, no sensor_sample inserts)
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });
});
