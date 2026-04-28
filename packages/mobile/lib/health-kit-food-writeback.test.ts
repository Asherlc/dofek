import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFoodWriteBackFingerprint,
  type FoodWriteBackStorage,
  type HealthKitFoodWriteBackAdapter,
  type HealthKitFoodWriteBackTrpcClient,
  syncDofekFoodToHealthKit,
} from "./health-kit-food-writeback";

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

function createStorage(initial: string | null = null): FoodWriteBackStorage {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

function createClient(
  entries: Awaited<
    ReturnType<HealthKitFoodWriteBackTrpcClient["food"]["healthKitWriteBackEntries"]["query"]>
  >,
): HealthKitFoodWriteBackTrpcClient {
  return {
    food: {
      healthKitWriteBackEntries: {
        query: vi.fn(async () => entries),
      },
    },
  };
}

function createHealthKit(): HealthKitFoodWriteBackAdapter {
  return {
    writeDietarySamples: vi.fn(async () => true),
    deleteDietarySamples: vi.fn(async () => 0),
  };
}

describe("syncDofekFoodToHealthKit", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it("writes calories and macros for direct Dofek food entries", async () => {
    const client = createClient([
      {
        id: "food-1",
        date: "2026-04-28",
        food_name: "Chicken Rice Bowl",
        calories: 640,
        protein_g: 42,
        carbs_g: 68,
        fat_g: 18,
      },
    ]);
    const healthKit = createHealthKit();
    const storage = createStorage();

    const result = await syncDofekFoodToHealthKit({
      trpcClient: client,
      healthKit,
      storage,
      startDate: "2026-04-28",
      endDate: "2026-04-28",
    });

    expect(result).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(healthKit.writeDietarySamples).toHaveBeenCalledWith([
      expect.objectContaining({
        typeIdentifier: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 640,
        unit: "kcal",
        syncIdentifier: "dofek:food:food-1:HKQuantityTypeIdentifierDietaryEnergyConsumed",
      }),
      expect.objectContaining({
        typeIdentifier: "HKQuantityTypeIdentifierDietaryProtein",
        value: 42,
        unit: "g",
      }),
      expect.objectContaining({
        typeIdentifier: "HKQuantityTypeIdentifierDietaryCarbohydrates",
        value: 68,
        unit: "g",
      }),
      expect.objectContaining({
        typeIdentifier: "HKQuantityTypeIdentifierDietaryFatTotal",
        value: 18,
        unit: "g",
      }),
    ]);
    expect(storage.setItem).toHaveBeenCalledWith(
      "dofek_healthkit_food_writeback_v1",
      JSON.stringify({
        "food-1": buildFoodWriteBackFingerprint({
          date: "2026-04-28",
          calories: 640,
          protein_g: 42,
          carbs_g: 68,
          fat_g: 18,
        }),
      }),
    );
  });

  it("skips entries with an already-written fingerprint", async () => {
    const entry = {
      id: "food-1",
      date: "2026-04-28",
      food_name: "Chicken Rice Bowl",
      calories: 640,
      protein_g: 42,
      carbs_g: 68,
      fat_g: 18,
    };
    const fingerprint = buildFoodWriteBackFingerprint(entry);
    const client = createClient([entry]);
    const healthKit = createHealthKit();
    const storage = createStorage(JSON.stringify({ "food-1": fingerprint }));

    const result = await syncDofekFoodToHealthKit({
      trpcClient: client,
      healthKit,
      storage,
      startDate: "2026-04-28",
      endDate: "2026-04-28",
    });

    expect(result).toEqual({ written: 0, skipped: 1, errors: [] });
    expect(healthKit.deleteDietarySamples).not.toHaveBeenCalled();
    expect(healthKit.writeDietarySamples).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("deletes old Dofek samples before rewriting a changed entry", async () => {
    const entry = {
      id: "food-1",
      date: "2026-04-28",
      food_name: "Chicken Rice Bowl",
      calories: 700,
      protein_g: 42,
      carbs_g: 68,
      fat_g: 18,
    };
    const client = createClient([entry]);
    const healthKit = createHealthKit();
    const storage = createStorage(JSON.stringify({ "food-1": "old-fingerprint" }));

    const result = await syncDofekFoodToHealthKit({
      trpcClient: client,
      healthKit,
      storage,
      startDate: "2026-04-28",
      endDate: "2026-04-28",
    });

    expect(result.errors).toEqual([]);
    expect(healthKit.deleteDietarySamples).toHaveBeenCalledWith([
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryEnergyConsumed",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryProtein",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryCarbohydrates",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryFatTotal",
    ]);
    expect(healthKit.writeDietarySamples).toHaveBeenCalledOnce();
  });

  it("does not write absent nutrients", async () => {
    const client = createClient([
      {
        id: "food-1",
        date: "2026-04-28",
        food_name: "Quick Add",
        calories: 250,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
      },
    ]);
    const healthKit = createHealthKit();
    const storage = createStorage();

    await syncDofekFoodToHealthKit({
      trpcClient: client,
      healthKit,
      storage,
      startDate: "2026-04-28",
      endDate: "2026-04-28",
    });

    expect(healthKit.writeDietarySamples).toHaveBeenCalledWith([
      expect.objectContaining({
        typeIdentifier: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 250,
      }),
    ]);
  });

  it("captures HealthKit write failures and leaves the ledger unchanged for that entry", async () => {
    const error = new Error("HealthKit write denied");
    const client = createClient([
      {
        id: "food-1",
        date: "2026-04-28",
        food_name: "Chicken Rice Bowl",
        calories: 640,
        protein_g: 42,
        carbs_g: 68,
        fat_g: 18,
      },
    ]);
    const healthKit = createHealthKit();
    vi.mocked(healthKit.writeDietarySamples).mockRejectedValue(error);
    const storage = createStorage();

    const result = await syncDofekFoodToHealthKit({
      trpcClient: client,
      healthKit,
      storage,
      startDate: "2026-04-28",
      endDate: "2026-04-28",
    });

    expect(result.written).toBe(0);
    expect(result.errors).toEqual(["Chicken Rice Bowl: HealthKit write denied"]);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "healthkit-food-writeback",
      foodEntryId: "food-1",
      foodName: "Chicken Rice Bowl",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
