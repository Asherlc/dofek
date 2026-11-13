import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearManualHealthKitCheckpoint,
  InvalidManualHealthKitCheckpointError,
  loadManualHealthKitCheckpoint,
  type ManualHealthKitCheckpoint,
  purgeManualHealthKitCheckpoint,
  saveManualHealthKitCheckpoint,
} from "./health-kit-manual-checkpoint";

// Duplicated on purpose: the per-account key derivation is the persisted
// storage contract shared with the account cleanup paths, not an internal detail.
function checkpointKey(userId: string): string {
  return `dofek_manual_health_kit_checkpoint_v1.${userId}`;
}

const FIRST_USER = "user-1";
const SECOND_USER = "user-2";
const FIRST_REQUEST = "11111111-1111-4111-8111-111111111111";
const SECOND_REQUEST = "22222222-2222-4222-8222-222222222222";
const INVALID_CHECKPOINT_MESSAGE = "Stored Apple Health sync checkpoint is invalid.";

function checkpoint(overrides: Partial<ManualHealthKitCheckpoint> = {}): ManualHealthKitCheckpoint {
  return {
    requestId: FIRST_REQUEST,
    userId: FIRST_USER,
    startDate: "2026-03-01T00:00:00.000Z",
    endDate: "2026-03-02T00:00:00.000Z",
    nextStage: "sleep",
    requiresResume: true,
    ...overrides,
  };
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await SecureStore.deleteItemAsync(checkpointKey(FIRST_USER));
  await SecureStore.deleteItemAsync(checkpointKey(SECOND_USER));
  vi.mocked(SecureStore.getItemAsync).mockClear();
  vi.mocked(SecureStore.setItemAsync).mockClear();
  vi.mocked(SecureStore.deleteItemAsync).mockClear();
});

describe("manual HealthKit checkpoint storage", () => {
  it("recreates the fixed request window and resume cursor after a process restart", async () => {
    const stored = checkpoint();

    await saveManualHealthKitCheckpoint(stored);

    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
  });

  it("keeps each account's pending request in its own key", async () => {
    const firstAccount = checkpoint({ userId: FIRST_USER });
    const secondAccount = checkpoint({ userId: SECOND_USER });

    await saveManualHealthKitCheckpoint(firstAccount);
    await saveManualHealthKitCheckpoint(secondAccount);

    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(firstAccount);
    expect(await loadManualHealthKitCheckpoint(SECOND_USER)).toEqual(secondAccount);
  });

  it("treats an account without a pending request as absent", async () => {
    await saveManualHealthKitCheckpoint(checkpoint({ userId: FIRST_USER }));

    expect(await loadManualHealthKitCheckpoint(SECOND_USER)).toBeNull();
    expect(await SecureStore.getItemAsync(checkpointKey(FIRST_USER))).not.toBeNull();
  });

  it("clears only the matching account and request", async () => {
    const stored = checkpoint();
    await saveManualHealthKitCheckpoint(stored);

    await clearManualHealthKitCheckpoint(FIRST_USER, SECOND_REQUEST);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);

    await clearManualHealthKitCheckpoint(SECOND_USER, stored.requestId);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);

    await clearManualHealthKitCheckpoint(FIRST_USER, stored.requestId);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toBeNull();
  });

  it("refuses a stale write that would resurrect a replaced request", async () => {
    const replaced = checkpoint();
    const replacement = checkpoint({
      requestId: SECOND_REQUEST,
      startDate: "2026-04-01T00:00:00.000Z",
      endDate: "2026-04-02T00:00:00.000Z",
    });
    await saveManualHealthKitCheckpoint(replaced);

    await expect(saveManualHealthKitCheckpoint(replacement)).rejects.toThrow(/clear it first/i);

    await clearManualHealthKitCheckpoint(FIRST_USER, replaced.requestId);
    await saveManualHealthKitCheckpoint(replacement);
    await expect(saveManualHealthKitCheckpoint(replaced)).rejects.toThrow(/clear it first/i);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(replacement);
  });

  it("orders a stale clear before a replacement request", async () => {
    const replaced = checkpoint();
    const replacement = checkpoint({
      requestId: SECOND_REQUEST,
      startDate: "2026-04-01T00:00:00.000Z",
      endDate: "2026-04-02T00:00:00.000Z",
    });
    await saveManualHealthKitCheckpoint(replaced);

    const staleReadCaptured = deferred<void>();
    const releaseStaleRead = deferred<void>();
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async (key) => {
      const staleValue = await SecureStore.getItemAsync(key);
      staleReadCaptured.resolve();
      await releaseStaleRead.promise;
      return staleValue;
    });

    const staleClear = clearManualHealthKitCheckpoint(FIRST_USER, replaced.requestId);
    await staleReadCaptured.promise;
    const repeatedClear = clearManualHealthKitCheckpoint(FIRST_USER, replaced.requestId);
    const replacementSave = saveManualHealthKitCheckpoint(replacement);
    releaseStaleRead.resolve();

    await Promise.all([staleClear, repeatedClear, replacementSave]);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(replacement);
  });

  it("orders purge after an in-flight save so it cannot resurrect the request", async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      await SecureStore.setItemAsync(key, value);
    });

    const pendingSave = saveManualHealthKitCheckpoint(checkpoint());
    await writeStarted.promise;
    const purge = purgeManualHealthKitCheckpoint(FIRST_USER);
    releaseWrite.resolve();

    await Promise.all([pendingSave, purge]);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toBeNull();
  });

  it("recovers ordered storage after an operation rejects", async () => {
    const failure = new Error("Keychain unavailable");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(failure);

    await expect(loadManualHealthKitCheckpoint(FIRST_USER)).rejects.toBe(failure);

    const stored = checkpoint();
    await saveManualHealthKitCheckpoint(stored);
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
  });

  it("fails explicitly when the stored request is corrupt", async () => {
    await SecureStore.setItemAsync(checkpointKey(FIRST_USER), "{not-json");

    await expect(loadManualHealthKitCheckpoint(FIRST_USER)).rejects.toBeInstanceOf(
      InvalidManualHealthKitCheckpointError,
    );
  });

  it.each([
    ["an unknown stage", JSON.stringify({ ...checkpoint(), nextStage: "raw:not-a-stage" })],
    ["a missing resume flag", JSON.stringify({ ...checkpoint(), requiresResume: undefined })],
    ["a reversed window", JSON.stringify({ ...checkpoint(), endDate: "2026-02-28T00:00:00.000Z" })],
    ["an empty request id", JSON.stringify({ ...checkpoint(), requestId: "" })],
    ["another account's identity", JSON.stringify({ ...checkpoint(), userId: SECOND_USER })],
  ])("rejects persisted input with %s", async (_label, raw) => {
    await SecureStore.setItemAsync(checkpointKey(FIRST_USER), raw);

    await expect(loadManualHealthKitCheckpoint(FIRST_USER)).rejects.toThrow(
      INVALID_CHECKPOINT_MESSAGE,
    );
  });

  it("purges the account's request even when the stored payload is corrupt", async () => {
    await SecureStore.setItemAsync(checkpointKey(FIRST_USER), "not-json");

    await purgeManualHealthKitCheckpoint(FIRST_USER);

    expect(await SecureStore.getItemAsync(checkpointKey(FIRST_USER))).toBeNull();
  });

  it("purges one account's corrupt request without touching another account", async () => {
    const stored = checkpoint({ userId: FIRST_USER });
    await saveManualHealthKitCheckpoint(stored);
    await SecureStore.setItemAsync(checkpointKey(SECOND_USER), "not-json");

    await purgeManualHealthKitCheckpoint(SECOND_USER);

    expect(await SecureStore.getItemAsync(checkpointKey(SECOND_USER))).toBeNull();
    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
  });

  it("purges a stored request for the matching account", async () => {
    await saveManualHealthKitCheckpoint(checkpoint({ userId: FIRST_USER }));

    await purgeManualHealthKitCheckpoint(FIRST_USER);

    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toBeNull();
  });

  it("leaves another account's valid request in place when purging", async () => {
    const stored = checkpoint({ userId: FIRST_USER });
    await saveManualHealthKitCheckpoint(stored);

    await purgeManualHealthKitCheckpoint(SECOND_USER);

    expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
  });

  it.each(["User interaction is not allowed", "errSecInteractionNotAllowed"])(
    "surfaces the keychain error %s when purging and keeps the request",
    async (message) => {
      const stored = checkpoint();
      await saveManualHealthKitCheckpoint(stored);
      vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error(message));

      await expect(purgeManualHealthKitCheckpoint(FIRST_USER)).rejects.toThrow(message);
      expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
    },
  );

  it.each(["User interaction is not allowed", "errSecInteractionNotAllowed"])(
    "surfaces the keychain error %s when clearing instead of blocking the next save",
    async (message) => {
      const stored = checkpoint();
      await saveManualHealthKitCheckpoint(stored);
      vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error(message));

      await expect(clearManualHealthKitCheckpoint(FIRST_USER, stored.requestId)).rejects.toThrow(
        message,
      );
      expect(await loadManualHealthKitCheckpoint(FIRST_USER)).toEqual(stored);
    },
  );

  it("propagates secure-storage read, write, and delete failures", async () => {
    const failure = new Error("Keychain unavailable");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(failure);
    await expect(loadManualHealthKitCheckpoint(FIRST_USER)).rejects.toBe(failure);

    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(failure);
    await expect(saveManualHealthKitCheckpoint(checkpoint())).rejects.toBe(failure);

    await saveManualHealthKitCheckpoint(checkpoint());
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(failure);
    await expect(clearManualHealthKitCheckpoint(FIRST_USER, checkpoint().requestId)).rejects.toBe(
      failure,
    );

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(failure);
    await expect(purgeManualHealthKitCheckpoint(FIRST_USER)).rejects.toBe(failure);
  });
});
