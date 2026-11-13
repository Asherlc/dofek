import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { MANUAL_HEALTH_KIT_SYNC_STAGES } from "./health-kit-sync";
import type { ManualHealthKitSyncStage } from "./health-kit-sync-types";
import { readSecureStoreItem, writeSecureStoreItem } from "./secure-store-access";

const CHECKPOINT_KEY_PREFIX = "dofek_manual_health_kit_checkpoint_v1";
const INVALID_CHECKPOINT_MESSAGE = "Stored Apple Health sync checkpoint is invalid.";

export class InvalidManualHealthKitCheckpointError extends Error {
  constructor() {
    super(INVALID_CHECKPOINT_MESSAGE);
    this.name = "InvalidManualHealthKitCheckpointError";
  }
}

/**
 * Each account owns its own SecureStore key, so one account can never occupy,
 * block, or purge another account's pending request.
 */
function checkpointKey(userId: string): string {
  return `${CHECKPOINT_KEY_PREFIX}.${userId}`;
}

/**
 * SecureStore offers no compare-and-swap, so whole read/compare/write/delete
 * operations are ordered through one chain. A failed operation must not block
 * later cleanup, so the chain continues after both outcomes.
 */
let storageOperationChain: Promise<unknown> = Promise.resolve();

function orderStorageOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = storageOperationChain.then(operation, operation);
  storageOperationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Deletion must report failure: the shared helper intentionally ignores
 * keychain lock errors, which would let cleanup claim success while the
 * request is still stored.
 */
async function deleteCheckpointItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

export interface ManualHealthKitCheckpoint {
  requestId: string;
  userId: string;
  startDate: string;
  endDate: string;
  nextStage: ManualHealthKitSyncStage;
  requiresResume: boolean;
}

const TimestampSchema = z.string().datetime({ offset: true });

const ManualHealthKitCheckpointSchema = z
  .object({
    requestId: z.string().min(1),
    userId: z.string().min(1),
    startDate: TimestampSchema,
    endDate: TimestampSchema,
    nextStage: z.custom<ManualHealthKitSyncStage>(
      (value) =>
        typeof value === "string" &&
        MANUAL_HEALTH_KIT_SYNC_STAGES.some((stageIdentifier) => stageIdentifier === value),
      { message: "Apple Health sync checkpoint stage is invalid." },
    ),
    requiresResume: z.boolean(),
  })
  .refine((checkpoint) => Date.parse(checkpoint.startDate) < Date.parse(checkpoint.endDate), {
    message: "Apple Health sync checkpoint window is invalid.",
    path: ["endDate"],
  });

function parseStoredCheckpoint(raw: string): ManualHealthKitCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidManualHealthKitCheckpointError();
  }
  const parsed = ManualHealthKitCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidManualHealthKitCheckpointError();
  }
  return parsed.data;
}

/** Loads the pending request only when it belongs to the authenticated account. */
export function loadManualHealthKitCheckpoint(
  userId: string,
): Promise<ManualHealthKitCheckpoint | null> {
  return orderStorageOperation(async () => {
    const raw = await readSecureStoreItem(checkpointKey(userId));
    if (raw === null) return null;
    const checkpoint = parseStoredCheckpoint(raw);
    if (checkpoint.userId !== userId) {
      throw new InvalidManualHealthKitCheckpointError();
    }
    return checkpoint;
  });
}

/**
 * Persists progress for one request. A different pending request must be
 * cleared first so a retired operation cannot overwrite its replacement.
 */
export function saveManualHealthKitCheckpoint(
  checkpoint: ManualHealthKitCheckpoint,
): Promise<void> {
  return orderStorageOperation(async () => {
    const next = ManualHealthKitCheckpointSchema.parse(checkpoint);
    const key = checkpointKey(next.userId);
    const raw = await readSecureStoreItem(key);
    if (raw !== null) {
      const existing = parseStoredCheckpoint(raw);
      if (existing.userId !== next.userId) {
        throw new Error(INVALID_CHECKPOINT_MESSAGE);
      }
      if (existing.requestId !== next.requestId) {
        throw new Error(
          "A different Apple Health sync request is already pending. Clear it first.",
        );
      }
    }
    await writeSecureStoreItem(key, JSON.stringify(next));
  });
}

/** Clears the pending request only when both the account and request match. */
export function clearManualHealthKitCheckpoint(userId: string, requestId: string): Promise<void> {
  return orderStorageOperation(async () => {
    const key = checkpointKey(userId);
    const raw = await readSecureStoreItem(key);
    if (raw === null) return;
    const existing = parseStoredCheckpoint(raw);
    if (existing.userId === userId && existing.requestId === requestId) {
      await deleteCheckpointItem(key);
    }
  });
}

/**
 * Account cleanup deletes this account's key unconditionally: a corrupt
 * payload can never be resumed, so it must not outlive sign-out or erasure.
 */
export function purgeManualHealthKitCheckpoint(userId: string): Promise<void> {
  return orderStorageOperation(async () => {
    await deleteCheckpointItem(checkpointKey(userId));
  });
}
