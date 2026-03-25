import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
  };
});

import { accelerometerSyncRouter } from "./accelerometer-sync.ts";

const createCaller = createTestCallerFactory(accelerometerSyncRouter);

function makeExecute() {
  return vi.fn().mockResolvedValue([]);
}

function makeSample(
  overrides: Partial<{ timestamp: string; x: number; y: number; z: number }> = {},
) {
  return {
    timestamp: "2026-03-25T10:00:00.020Z",
    x: 0.012,
    y: -0.981,
    z: 0.043,
    ...overrides,
  };
}

describe("accelerometerSyncRouter", () => {
  describe("pushAccelerometerSamples", () => {
    it("inserts samples with correct SQL", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushAccelerometerSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample(), makeSample({ timestamp: "2026-03-25T10:00:00.040Z", x: 0.015 })],
      });

      expect(result.inserted).toBe(2);
      // Should call execute twice: once for ensureProvider, once for the batch insert
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("handles empty samples array by returning zero inserted", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushAccelerometerSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [],
      });

      expect(result.inserted).toBe(0);
      // Only ensureProvider, no insert
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("rejects samples with missing required fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(
        caller.pushAccelerometerSamples({
          deviceId: "iPhone 15 Pro",
          deviceType: "iphone",
          // @ts-expect-error — intentionally passing invalid sample
          samples: [{ timestamp: "2026-03-25T10:00:00Z", x: 0.1 }],
        }),
      ).rejects.toThrow();
    });

    it("rejects when deviceId is empty", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(
        caller.pushAccelerometerSamples({
          deviceId: "",
          deviceType: "iphone",
          samples: [makeSample()],
        }),
      ).rejects.toThrow();
    });

    it("batches large sample arrays into multiple INSERT statements", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      // Create 7500 samples — should produce 2 batches (5000 + 2500)
      const samples = Array.from({ length: 7500 }, (_, i) =>
        makeSample({
          timestamp: `2026-03-25T10:00:${String(Math.floor(i / 50)).padStart(2, "0")}.${String((i % 50) * 20).padStart(3, "0")}Z`,
        }),
      );

      const result = await caller.pushAccelerometerSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples,
      });

      expect(result.inserted).toBe(7500);
      // 1 ensureProvider + 2 batch inserts
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });
});
