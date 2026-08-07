import { describe, expect, it, vi } from "vitest";
import type { HealthKitSample } from "./health-kit-sync-repository.ts";

vi.mock("../../../../src/db/sensor-channels.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/db/sensor-channels.ts")>();
  return {
    ...actual,
    BODY_MEASUREMENT_COLUMN_TO_CHANNEL: {},
  };
});

import { HealthKitSyncRepository } from "./health-kit-sync-repository.ts";

function makeSample(overrides: Partial<HealthKitSample> = {}): HealthKitSample {
  return {
    type: "HKQuantityTypeIdentifierBodyMass",
    value: 75.5,
    unit: "kg",
    startDate: "2024-01-15T10:00:00Z",
    endDate: "2024-01-15T10:30:00Z",
    sourceName: "iPhone",
    sourceBundle: "com.apple.Health",
    uuid: "bm-missing-channel",
    ...overrides,
  };
}

describe("HealthKitSyncRepository.processBodyMeasurements (channel mapping guard)", () => {
  it("throws when body column has no metric stream channel mapping", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const publisher = { publishRows: vi.fn(async () => []) };
    const repository = new HealthKitSyncRepository({ execute }, "user-1", publisher);

    await expect(repository.processBodyMeasurements([makeSample()])).rejects.toThrow(
      "Missing metric stream channel mapping for body column: weight_kg",
    );
  });
});
