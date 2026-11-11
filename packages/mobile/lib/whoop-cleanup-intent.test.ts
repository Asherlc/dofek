import { beforeEach, describe, expect, it, vi } from "vitest";

const storedValues = vi.hoisted(() => new Map<string, string>());
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  AFTER_FIRST_UNLOCK: "kSecAttrAccessibleAfterFirstUnlock",
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn() }));

const cleanupIntentKey = "dofek_whoop_cleanup_intent_v1";
let intent: typeof import("./whoop-cleanup-intent");
let Crypto: typeof import("expo-crypto");

beforeEach(async () => {
  vi.resetModules();
  storedValues.clear();
  intent = await import("./whoop-cleanup-intent");
  Crypto = await import("expo-crypto");
  vi.mocked(Crypto.randomUUID).mockReset().mockReturnValue("11111111-1111-4111-8111-111111111111");
  vi.mocked(secureStore.getItemAsync)
    .mockReset()
    .mockImplementation(async (key) => {
      return storedValues.get(key) ?? null;
    });
  vi.mocked(secureStore.setItemAsync)
    .mockReset()
    .mockImplementation(async (key, value) => {
      storedValues.set(key, value);
    });
  vi.mocked(secureStore.deleteItemAsync)
    .mockReset()
    .mockImplementation(async (key) => {
      storedValues.delete(key);
    });
});

describe("WHOOP cleanup intent", () => {
  it("allows a live intent but blocks it after loading a fresh module instance", async () => {
    await intent.persistWhoopCleanupIntent();
    await expect(intent.requireWhoopCleanupToBeResolved()).resolves.toBeUndefined();

    vi.resetModules();
    const freshIntent = await import("./whoop-cleanup-intent");
    await expect(freshIntent.requireWhoopCleanupToBeResolved()).rejects.toThrow(
      /pending sensor cleanup/i,
    );
  });

  it("clears only the intent owned by the completed cleanup", async () => {
    const intentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const intentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.mocked(Crypto.randomUUID).mockReturnValueOnce(intentA).mockReturnValueOnce(intentB);

    await expect(intent.persistWhoopCleanupIntent()).resolves.toBe(intentA);
    await expect(intent.persistWhoopCleanupIntent()).resolves.toBe(intentB);
    await intent.clearWhoopCleanupIntent(intentA);
    expect(storedValues.get(cleanupIntentKey)).toBe(intentB);
    await expect(intent.requireWhoopCleanupToBeResolved()).resolves.toBeUndefined();

    await intent.clearWhoopCleanupIntent(intentB);
    expect(storedValues.has(cleanupIntentKey)).toBe(false);
    await expect(intent.requireWhoopCleanupToBeResolved()).resolves.toBeUndefined();
  });

  it("allows a live intent read to finish after its successful clear", async () => {
    const cleanupIntentId = await intent.persistWhoopCleanupIntent();
    let finishRead!: (value: string | null) => void;
    vi.mocked(secureStore.getItemAsync).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (finishRead = resolve)),
    );
    const checking = intent.requireWhoopCleanupToBeResolved();
    try {
      await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
      await intent.clearWhoopCleanupIntent(cleanupIntentId);
      finishRead(cleanupIntentId);
      await expect(checking).resolves.toBeUndefined();
    } finally {
      finishRead?.(cleanupIntentId);
      await Promise.allSettled([checking]);
    }
  });

  it("propagates unreadable and undeletable intent errors", async () => {
    const readFailure = new Error("SecureStore is unavailable");
    vi.mocked(secureStore.getItemAsync).mockRejectedValueOnce(readFailure);
    await expect(intent.requireWhoopCleanupToBeResolved()).rejects.toBe(readFailure);

    const cleanupIntentId = await intent.persistWhoopCleanupIntent();
    const deleteFailure = new Error("Intent deletion failed");
    vi.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(deleteFailure);
    await expect(intent.clearWhoopCleanupIntent(cleanupIntentId)).rejects.toBe(deleteFailure);
    expect(storedValues.get(cleanupIntentKey)).toBe(cleanupIntentId);
  });
});
