import { describe, expect, it, vi } from "vitest";
import type {
  FoodWriteBackStorage,
  HealthKitFoodWriteBackAdapter,
} from "./health-kit-food-writeback";
import {
  FOOD_WRITE_BACK_STORAGE_KEY,
  purgeDofekFoodWriteBackFromHealthKit,
} from "./health-kit-food-writeback";

function storage(raw: string | null): FoodWriteBackStorage {
  return {
    getItem: vi.fn(async () => raw),
    deleteItem: vi.fn(async () => undefined),
    setItem: vi.fn(async () => undefined),
  };
}

describe("purgeDofekFoodWriteBackFromHealthKit", () => {
  it("deletes legacy Dofek dietary samples and clears the local ledger", async () => {
    const healthKit: HealthKitFoodWriteBackAdapter = {
      deleteDietarySamples: vi.fn(async () => 8),
    };
    const localStorage = storage(JSON.stringify({ "food-1": "fingerprint" }));

    const deleted = await purgeDofekFoodWriteBackFromHealthKit({
      healthKit,
      storage: localStorage,
    });

    expect(deleted).toBe(4);
    expect(healthKit.deleteDietarySamples).toHaveBeenCalledWith([
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryEnergyConsumed",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryProtein",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryCarbohydrates",
      "dofek:food:food-1:HKQuantityTypeIdentifierDietaryFatTotal",
    ]);
    expect(localStorage.deleteItem).toHaveBeenCalledWith(FOOD_WRITE_BACK_STORAGE_KEY);
  });
});
