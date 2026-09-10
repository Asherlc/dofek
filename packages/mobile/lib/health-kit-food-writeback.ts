import { z } from "zod";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";
import { captureException } from "./telemetry";

export const FOOD_WRITE_BACK_STORAGE_KEY = "dofek_healthkit_food_writeback_v1";

export interface FoodWriteBackStorage {
  deleteItem(key: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface HealthKitFoodWriteBackAdapter {
  deleteDietarySamples(syncIdentifiers: string[]): Promise<number>;
}

const ledgerSchema = z.record(z.string(), z.string());

export const secureStoreFoodWriteBackStorage: FoodWriteBackStorage = {
  deleteItem: (key) => deleteSecureStoreItem(key),
  getItem: (key) => readSecureStoreItem(key),
  setItem: (key, value) => writeSecureStoreItem(key, value),
};

const WRITABLE_NUTRIENT_TYPE_IDENTIFIERS = [
  "HKQuantityTypeIdentifierDietaryEnergyConsumed",
  "HKQuantityTypeIdentifierDietaryProtein",
  "HKQuantityTypeIdentifierDietaryCarbohydrates",
  "HKQuantityTypeIdentifierDietaryFatTotal",
] as const;

function loadLedger(rawLedger: string | null): Record<string, string> {
  if (!rawLedger) return {};
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(rawLedger));
    return parsed.success ? parsed.data : {};
  } catch (error: unknown) {
    captureException(error, { source: "healthkit-food-writeback-ledger-parse" });
    return {};
  }
}

function allSyncIdentifiers(foodEntryId: string): string[] {
  return WRITABLE_NUTRIENT_TYPE_IDENTIFIERS.map(
    (typeIdentifier) => `dofek:food:${foodEntryId}:${typeIdentifier}`,
  );
}

/** Remove legacy Dofek-written HealthKit samples during account erasure. */
export async function purgeDofekFoodWriteBackFromHealthKit({
  healthKit,
  storage = secureStoreFoodWriteBackStorage,
}: {
  healthKit: Pick<HealthKitFoodWriteBackAdapter, "deleteDietarySamples">;
  storage?: FoodWriteBackStorage;
}): Promise<number> {
  const ledger = loadLedger(await storage.getItem(FOOD_WRITE_BACK_STORAGE_KEY));
  const syncIdentifiers = Object.keys(ledger).flatMap(allSyncIdentifiers);
  if (syncIdentifiers.length > 0) {
    await healthKit.deleteDietarySamples(syncIdentifiers);
  }
  await storage.deleteItem(FOOD_WRITE_BACK_STORAGE_KEY);
  return syncIdentifiers.length;
}
