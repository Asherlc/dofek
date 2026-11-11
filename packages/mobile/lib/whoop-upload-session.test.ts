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
const uploadContext = {
  userId: "user",
  token: "secret",
  serverURL: "https://example.com",
  headers: { "x-app-version": "1" },
};
let session: typeof import("./whoop-upload-session");
let Crypto: typeof import("expo-crypto");
let whoopBle: typeof import("../modules/whoop-ble");

beforeEach(async () => {
  vi.resetModules();
  storedValues.clear();
  session = await import("./whoop-upload-session");
  Crypto = await import("expo-crypto");
  whoopBle = await import("../modules/whoop-ble");
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
  vi.mocked(whoopBle.configureUpload).mockReset().mockResolvedValue(undefined);
  vi.mocked(whoopBle.disableUploads).mockReset().mockResolvedValue(undefined);
  vi.mocked(whoopBle.purgeAccountState).mockReset().mockResolvedValue(true);
});

describe("WHOOP upload session", () => {
  it("configures native uploads when no cleanup intent exists", async () => {
    await session.configureWhoopUploads(uploadContext);
    expect(whoopBle.configureUpload).toHaveBeenCalledWith(uploadContext);
  });

  it("allows a live intent but blocks it after loading a fresh module instance", async () => {
    await session.persistWhoopCleanupIntent();
    await session.configureWhoopUploads(uploadContext);
    expect(whoopBle.configureUpload).toHaveBeenCalledOnce();

    vi.resetModules();
    const freshSession = await import("./whoop-upload-session");
    await expect(freshSession.configureWhoopUploads(uploadContext)).rejects.toThrow(
      /pending sensor cleanup/i,
    );
    expect(whoopBle.configureUpload).toHaveBeenCalledOnce();
  });

  it("clears only the intent owned by the completed cleanup", async () => {
    const intentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const intentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.mocked(Crypto.randomUUID).mockReturnValueOnce(intentA).mockReturnValueOnce(intentB);

    await expect(session.persistWhoopCleanupIntent()).resolves.toBe(intentA);
    await expect(session.persistWhoopCleanupIntent()).resolves.toBe(intentB);
    await session.clearWhoopCleanupIntent(intentA);
    expect(storedValues.get(cleanupIntentKey)).toBe(intentB);
    await session.configureWhoopUploads(uploadContext);

    await session.clearWhoopCleanupIntent(intentB);
    expect(storedValues.has(cleanupIntentKey)).toBe(false);
    await session.configureWhoopUploads(uploadContext);
  });

  it("allows a live intent read to finish after its successful clear", async () => {
    const cleanupIntentId = await session.persistWhoopCleanupIntent();
    let finishRead!: (value: string | null) => void;
    vi.mocked(secureStore.getItemAsync).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (finishRead = resolve)),
    );
    const checking = session.configureWhoopUploads(uploadContext);
    try {
      await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
      await session.clearWhoopCleanupIntent(cleanupIntentId);
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
    await expect(session.configureWhoopUploads(uploadContext)).rejects.toBe(readFailure);
    expect(whoopBle.configureUpload).not.toHaveBeenCalled();

    const cleanupIntentId = await session.persistWhoopCleanupIntent();
    const deleteFailure = new Error("Intent deletion failed");
    vi.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(deleteFailure);
    await expect(session.clearWhoopCleanupIntent(cleanupIntentId)).rejects.toBe(deleteFailure);
    expect(storedValues.get(cleanupIntentKey)).toBe(cleanupIntentId);
  });

  it("dispatches replacement configuration after disable enters the native FIFO", async () => {
    await session.persistWhoopCleanupIntent();
    let finishCleanup!: () => void;
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    vi.mocked(whoopBle.disableUploads).mockImplementationOnce(() => pendingCleanup);
    const cleanup = session.disableWhoopUploads();
    const configuring = session.configureWhoopUploads(uploadContext);
    try {
      await vi.waitFor(() => expect(whoopBle.configureUpload).toHaveBeenCalledOnce());
      expect(whoopBle.configureUpload.mock.invocationCallOrder[0]).toBeGreaterThan(
        whoopBle.disableUploads.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      finishCleanup();
      await Promise.all([cleanup, configuring]);
    }
  });

  it.each(["disable", "purge"] as const)(
    "does not dispatch a delayed configuration overtaken by %s",
    async (cleanup) => {
      let finishRead: ((value: string | null) => void) | undefined;
      vi.mocked(secureStore.getItemAsync).mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (finishRead = resolve)),
      );
      const configuring = session.configureWhoopUploads(uploadContext);
      try {
        await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
        if (cleanup === "disable") {
          await session.disableWhoopUploads();
          expect(whoopBle.disableUploads).toHaveBeenCalledOnce();
        } else {
          await session.purgeWhoopAccountState("2026-11-11T00:00:00.000Z");
          expect(whoopBle.purgeAccountState).toHaveBeenCalledOnce();
        }
        finishRead?.(null);
        await expect(configuring).rejects.toThrow(/superseded by account cleanup/i);
        expect(whoopBle.configureUpload).not.toHaveBeenCalled();
      } finally {
        finishRead?.(null);
        await Promise.allSettled([configuring]);
      }
    },
  );
});
