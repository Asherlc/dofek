import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearManualHealthKitCheckpoint,
  loadManualHealthKitCheckpoint,
  type ManualHealthKitCheckpoint,
  purgeManualHealthKitCheckpoint,
  saveManualHealthKitCheckpoint,
} from "./health-kit-manual-checkpoint";
import { captureException } from "./telemetry";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

// Duplicated on purpose: the persisted key is a storage contract, not an
// internal detail the tests should reach into.
const MANUAL_HEALTH_KIT_CHECKPOINT_KEY = "dofek_manual_health_kit_checkpoint_v1";

function checkpoint(overrides: Partial<ManualHealthKitCheckpoint> = {}): ManualHealthKitCheckpoint {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    startDate: "2026-03-01T00:00:00.000Z",
    endDate: "2026-03-02T00:00:00.000Z",
    nextStage: "sleep",
    requiresResume: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await SecureStore.deleteItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  vi.mocked(captureException).mockClear();
  vi.mocked(SecureStore.getItemAsync).mockClear();
  vi.mocked(SecureStore.setItemAsync).mockClear();
  vi.mocked(SecureStore.deleteItemAsync).mockClear();
});

describe("manual HealthKit checkpoint storage", () => {
  it("recreates the fixed request window and resume cursor after a process restart", async () => {
    const stored = checkpoint();

    await saveManualHealthKitCheckpoint(stored);

    expect(await loadManualHealthKitCheckpoint("user-1")).toEqual(stored);
  });

  it("treats another account's stored request as absent", async () => {
    await saveManualHealthKitCheckpoint(checkpoint({ userId: "user-1" }));

    expect(await loadManualHealthKitCheckpoint("user-2")).toBeNull();
    expect(await SecureStore.getItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY)).not.toBeNull();
  });

  it("clears only the matching account and request", async () => {
    const stored = checkpoint();
    await saveManualHealthKitCheckpoint(stored);

    await clearManualHealthKitCheckpoint("user-1", "22222222-2222-4222-8222-222222222222");
    expect(await loadManualHealthKitCheckpoint("user-1")).toEqual(stored);

    await clearManualHealthKitCheckpoint("user-2", stored.requestId);
    expect(await loadManualHealthKitCheckpoint("user-1")).toEqual(stored);

    await clearManualHealthKitCheckpoint("user-1", stored.requestId);
    expect(await loadManualHealthKitCheckpoint("user-1")).toBeNull();
  });

  it("refuses a stale write that would resurrect a replaced request", async () => {
    const replaced = checkpoint();
    const replacement = checkpoint({
      requestId: "22222222-2222-4222-8222-222222222222",
      startDate: "2026-04-01T00:00:00.000Z",
      endDate: "2026-04-02T00:00:00.000Z",
    });
    await saveManualHealthKitCheckpoint(replaced);

    await expect(saveManualHealthKitCheckpoint(replacement)).rejects.toThrow(/clear it first/i);

    await clearManualHealthKitCheckpoint("user-1", replaced.requestId);
    await saveManualHealthKitCheckpoint(replacement);
    await expect(saveManualHealthKitCheckpoint(replaced)).rejects.toThrow(/clear it first/i);
    expect(await loadManualHealthKitCheckpoint("user-1")).toEqual(replacement);
  });

  it("fails explicitly when the stored request is corrupt", async () => {
    await SecureStore.setItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY, "{not-json");

    await expect(loadManualHealthKitCheckpoint("user-1")).rejects.toThrow(
      "Stored Apple Health sync checkpoint is invalid.",
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown stage", JSON.stringify({ ...checkpoint(), nextStage: "raw:not-a-stage" })],
    ["a missing resume flag", JSON.stringify({ ...checkpoint(), requiresResume: undefined })],
    ["a reversed window", JSON.stringify({ ...checkpoint(), endDate: "2026-02-28T00:00:00.000Z" })],
    ["an empty request id", JSON.stringify({ ...checkpoint(), requestId: "" })],
  ])("rejects persisted input with %s", async (_label, raw) => {
    await SecureStore.setItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY, raw);

    await expect(loadManualHealthKitCheckpoint("user-1")).rejects.toThrow(
      "Stored Apple Health sync checkpoint is invalid.",
    );
  });

  it("purges the account's request even when the stored payload is corrupt", async () => {
    await SecureStore.setItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY, "not-json");

    await purgeManualHealthKitCheckpoint("user-1");

    expect(await SecureStore.getItemAsync(MANUAL_HEALTH_KIT_CHECKPOINT_KEY)).toBeNull();
  });

  it("purges a stored request for the matching account", async () => {
    await saveManualHealthKitCheckpoint(checkpoint({ userId: "user-1" }));

    await purgeManualHealthKitCheckpoint("user-1");

    expect(await loadManualHealthKitCheckpoint("user-1")).toBeNull();
  });

  it("leaves another account's valid request in place when purging", async () => {
    const stored = checkpoint({ userId: "user-1" });
    await saveManualHealthKitCheckpoint(stored);

    await purgeManualHealthKitCheckpoint("user-2");

    expect(await loadManualHealthKitCheckpoint("user-1")).toEqual(stored);
  });

  it("propagates secure-storage read, write, and delete failures", async () => {
    const failure = new Error("Keychain unavailable");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(failure);
    await expect(loadManualHealthKitCheckpoint("user-1")).rejects.toBe(failure);

    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(failure);
    await expect(saveManualHealthKitCheckpoint(checkpoint())).rejects.toBe(failure);

    await saveManualHealthKitCheckpoint(checkpoint());
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(failure);
    await expect(clearManualHealthKitCheckpoint("user-1", checkpoint().requestId)).rejects.toBe(
      failure,
    );

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(failure);
    await expect(purgeManualHealthKitCheckpoint("user-1")).rejects.toBe(failure);
  });
});
