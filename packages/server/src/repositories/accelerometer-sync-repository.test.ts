import { describe, expect, it, vi } from "vitest";
import { AccelerometerSyncRepository } from "./accelerometer-sync-repository.ts";
import type { AccelerometerSample } from "./accelerometer-sync-repository.ts";

function makeRepository() {
  const execute = vi.fn().mockResolvedValue([]);
  const db = { execute };
  const repository = new AccelerometerSyncRepository(db, "user-1");
  return { repository, execute };
}

function makeSample(overrides: Partial<AccelerometerSample> = {}): AccelerometerSample {
  return {
    timestamp: "2024-01-15T10:00:00.000Z",
    x: 0.1,
    y: -0.3,
    z: 9.8,
    ...overrides,
  };
}

describe("AccelerometerSyncRepository", () => {
  describe("ensureProvider", () => {
    it("executes an INSERT for the apple_motion provider", async () => {
      const { repository, execute } = makeRepository();
      await repository.ensureProvider();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("insertBatch", () => {
    it("returns 0 for empty samples without calling execute", async () => {
      const { repository, execute } = makeRepository();
      const result = await repository.insertBatch("device-1", "iPhone", []);
      expect(result).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });

    it("inserts samples and returns count", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({ timestamp: "2024-01-15T10:00:00.000Z" }),
        makeSample({ timestamp: "2024-01-15T10:00:00.020Z" }),
        makeSample({ timestamp: "2024-01-15T10:00:00.040Z" }),
      ];

      const result = await repository.insertBatch("device-1", "iPhone", samples);
      expect(result).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("splits large sample sets into batches of 5000", async () => {
      const { repository, execute } = makeRepository();
      const samples = Array.from({ length: 12000 }, (_, index) =>
        makeSample({ timestamp: `2024-01-15T10:00:00.${String(index).padStart(3, "0")}Z` }),
      );

      const result = await repository.insertBatch("device-1", "iPhone", samples);
      expect(result).toBe(12000);
      // 12000 / 5000 = 3 batches (5000 + 5000 + 2000)
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("inserts exactly one batch when sample count equals batch size", async () => {
      const { repository, execute } = makeRepository();
      const samples = Array.from({ length: 5000 }, (_, index) =>
        makeSample({ timestamp: `2024-01-15T10:00:00.${String(index).padStart(3, "0")}Z` }),
      );

      const result = await repository.insertBatch("device-1", "iPhone", samples);
      expect(result).toBe(5000);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
