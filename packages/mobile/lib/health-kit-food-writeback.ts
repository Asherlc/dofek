import { z } from "zod";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";
import { captureException } from "./telemetry";

export const FOOD_WRITE_BACK_STORAGE_KEY = "dofek_healthkit_food_writeback_v1";

const WRITABLE_NUTRIENTS = [
  {
    column: "calories",
    typeIdentifier: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
    unit: "kcal",
  },
  {
    column: "protein_g",
    typeIdentifier: "HKQuantityTypeIdentifierDietaryProtein",
    unit: "g",
  },
  {
    column: "carbs_g",
    typeIdentifier: "HKQuantityTypeIdentifierDietaryCarbohydrates",
    unit: "g",
  },
  {
    column: "fat_g",
    typeIdentifier: "HKQuantityTypeIdentifierDietaryFatTotal",
    unit: "g",
  },
] as const;

type WritableNutrientColumn = (typeof WRITABLE_NUTRIENTS)[number]["column"];

export interface DofekFoodWriteBackEntry extends Record<WritableNutrientColumn, number | null> {
  id: string;
  date: string;
  food_name: string;
}

export interface HealthKitDietarySample {
  typeIdentifier: string;
  value: number;
  unit: "kcal" | "g";
  startDate: string;
  endDate: string;
  syncIdentifier: string;
  syncVersion: number;
  foodEntryId: string;
  foodName: string;
  fingerprint: string;
}

export interface HealthKitFoodWriteBackTrpcClient {
  food: {
    healthKitWriteBackEntries: {
      query(input: { startDate: string; endDate: string }): Promise<DofekFoodWriteBackEntry[]>;
    };
  };
}

export interface HealthKitFoodWriteBackAdapter {
  writeDietarySamples(samples: HealthKitDietarySample[]): Promise<boolean>;
  deleteDietarySamples(syncIdentifiers: string[]): Promise<number>;
}

export interface FoodWriteBackStorage {
  deleteItem(key: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface FoodWriteBackOptions {
  trpcClient: HealthKitFoodWriteBackTrpcClient;
  healthKit: HealthKitFoodWriteBackAdapter;
  storage?: FoodWriteBackStorage;
  startDate: string;
  endDate: string;
}

export interface FoodWriteBackResult {
  written: number;
  skipped: number;
  errors: string[];
}

const ledgerSchema = z.record(z.string(), z.string());

export const secureStoreFoodWriteBackStorage: FoodWriteBackStorage = {
  deleteItem: (key) => deleteSecureStoreItem(key),
  getItem: (key) => readSecureStoreItem(key),
  setItem: (key, value) => writeSecureStoreItem(key, value),
};

export function buildFoodWriteBackFingerprint(
  entry: Pick<DofekFoodWriteBackEntry, "date" | WritableNutrientColumn>,
): string {
  return JSON.stringify([entry.date, entry.calories, entry.protein_g, entry.carbs_g, entry.fat_g]);
}

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

export function buildFoodWriteBackSyncIdentifier(
  foodEntryId: string,
  typeIdentifier: string,
): string {
  return `dofek:food:${foodEntryId}:${typeIdentifier}`;
}

function allSyncIdentifiers(foodEntryId: string): string[] {
  return WRITABLE_NUTRIENTS.map((nutrient) =>
    buildFoodWriteBackSyncIdentifier(foodEntryId, nutrient.typeIdentifier),
  );
}

function buildSamples(
  entry: DofekFoodWriteBackEntry,
  fingerprint: string,
): HealthKitDietarySample[] {
  const sampleDate = `${entry.date}T12:00:00Z`;
  return WRITABLE_NUTRIENTS.flatMap((nutrient) => {
    const value = entry[nutrient.column];
    if (value == null) return [];
    return [
      {
        typeIdentifier: nutrient.typeIdentifier,
        value,
        unit: nutrient.unit,
        startDate: sampleDate,
        endDate: sampleDate,
        syncIdentifier: buildFoodWriteBackSyncIdentifier(entry.id, nutrient.typeIdentifier),
        syncVersion: 1,
        foodEntryId: entry.id,
        foodName: entry.food_name,
        fingerprint,
      },
    ];
  });
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncDofekFoodToHealthKit(
  options: FoodWriteBackOptions,
): Promise<FoodWriteBackResult> {
  const storage = options.storage ?? secureStoreFoodWriteBackStorage;
  const entries = await options.trpcClient.food.healthKitWriteBackEntries.query({
    startDate: options.startDate,
    endDate: options.endDate,
  });
  const ledger = loadLedger(await storage.getItem(FOOD_WRITE_BACK_STORAGE_KEY));
  let ledgerChanged = false;
  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    const fingerprint = buildFoodWriteBackFingerprint(entry);
    if (ledger[entry.id] === fingerprint) {
      skipped++;
      continue;
    }

    const samples = buildSamples(entry, fingerprint);
    try {
      if (ledger[entry.id]) {
        await options.healthKit.deleteDietarySamples(allSyncIdentifiers(entry.id));
      }
      if (samples.length > 0) {
        await options.healthKit.writeDietarySamples(samples);
        written++;
        ledger[entry.id] = fingerprint;
      } else {
        delete ledger[entry.id];
        skipped++;
      }
      ledgerChanged = true;
    } catch (error: unknown) {
      captureException(error, {
        source: "healthkit-food-writeback",
        foodEntryId: entry.id,
        foodName: entry.food_name,
      });
      errors.push(`${entry.food_name}: ${errorMessage(error)}`);
    }
  }

  if (ledgerChanged) {
    await storage.setItem(FOOD_WRITE_BACK_STORAGE_KEY, JSON.stringify(ledger));
  }

  return { written, skipped, errors };
}
