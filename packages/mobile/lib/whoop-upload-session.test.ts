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
    expect(whoopBle.disableUploads).not.toHaveBeenCalled();
  });

  it("allows a live intent and resumes its cleanup after loading a fresh module instance", async () => {
    await session.persistWhoopCleanupIntent();
    await session.configureWhoopUploads(uploadContext);
    expect(whoopBle.configureUpload).toHaveBeenCalledOnce();

    vi.resetModules();
    const freshSession = await import("./whoop-upload-session");
    await freshSession.configureWhoopUploads(uploadContext);
    expect(whoopBle.disableUploads).toHaveBeenCalledOnce();
    expect(storedValues.has(cleanupIntentKey)).toBe(false);
    expect(whoopBle.configureUpload).toHaveBeenCalledTimes(2);
  });

  it("shares pending restart recovery and configures only the latest session after cleanup", async () => {
    storedValues.set(cleanupIntentKey, "interrupted-cleanup");
    let finishCleanup!: () => void;
    vi.mocked(whoopBle.disableUploads).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCleanup = resolve)),
    );
    const first = session.configureWhoopUploads(uploadContext);
    const firstOutcome = Promise.allSettled([first]);
    let second: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(whoopBle.disableUploads).toHaveBeenCalledOnce());
      const replacementContext = { ...uploadContext, userId: "replacement", token: "new-token" };
      second = session.configureWhoopUploads(replacementContext);
      await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledTimes(2));
      expect(whoopBle.configureUpload).not.toHaveBeenCalled();
      expect(storedValues.get(cleanupIntentKey)).toBe("interrupted-cleanup");
      finishCleanup();
      await second;
      expect(await firstOutcome).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
        },
      ]);
      expect(storedValues.has(cleanupIntentKey)).toBe(false);
      expect(whoopBle.disableUploads).toHaveBeenCalledOnce();
      expect(whoopBle.configureUpload).toHaveBeenCalledExactlyOnceWith(replacementContext);
      expect(whoopBle.configureUpload.mock.invocationCallOrder[0]).toBeGreaterThan(
        secureStore.deleteItemAsync.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      finishCleanup?.();
      await Promise.allSettled([firstOutcome, second]);
    }
  });

  it.each(["native", "intent deletion"])(
    "retains the restart fence after %s failure without repeating automatic cleanup",
    async (stage) => {
      storedValues.set(cleanupIntentKey, "interrupted-cleanup");
      const failure = new Error(`${stage} failed`);
      if (stage === "native") vi.mocked(whoopBle.disableUploads).mockRejectedValueOnce(failure);
      else secureStore.deleteItemAsync.mockRejectedValueOnce(failure);

      await expect(session.configureWhoopUploads(uploadContext)).rejects.toBe(failure);
      await expect(session.configureWhoopUploads(uploadContext)).rejects.toBe(failure);
      expect(whoopBle.disableUploads).toHaveBeenCalledOnce();
      expect(whoopBle.configureUpload).not.toHaveBeenCalled();
      expect(storedValues.get(cleanupIntentKey)).toBe("interrupted-cleanup");

      // The existing explicit sign-out cleanup can still recover this lifetime.
      await session.disableWhoopUploads();
      await session.clearWhoopCleanupIntent("interrupted-cleanup");
      await session.configureWhoopUploads(uploadContext);
      expect(whoopBle.configureUpload).toHaveBeenCalledWith(uploadContext);
    },
  );

  it.each(["disable", "purge"] as const)(
    "rejects recovery configuration overtaken by %s and preserves a newer intent",
    async (operation) => {
      storedValues.set(cleanupIntentKey, "interrupted-cleanup");
      let finishCleanup!: () => void;
      vi.mocked(whoopBle.disableUploads).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishCleanup = resolve)),
      );
      const configuring = session.configureWhoopUploads(uploadContext);
      const outcome = Promise.allSettled([configuring]);
      try {
        await vi.waitFor(() => expect(whoopBle.disableUploads).toHaveBeenCalledOnce());
        if (operation === "disable") await session.disableWhoopUploads();
        else await session.purgeWhoopAccountState("2026-11-12T00:00:00.000Z");
        const newerIntent = await session.persistWhoopCleanupIntent();
        finishCleanup();
        await expect(configuring).rejects.toThrow(/superseded/i);
        expect(storedValues.get(cleanupIntentKey)).toBe(newerIntent);
        expect(whoopBle.configureUpload).not.toHaveBeenCalled();
      } finally {
        finishCleanup?.();
        await outcome;
      }
    },
  );

  it("serializes intent deletion before a newer intent write", async () => {
    const oldIntent = await session.persistWhoopCleanupIntent();
    let finishDelete!: () => void;
    secureStore.deleteItemAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = () => {
            storedValues.delete(cleanupIntentKey);
            resolve();
          };
        }),
    );
    const clearing = session.clearWhoopCleanupIntent(oldIntent);
    let newer: Promise<string> | undefined;
    try {
      await vi.waitFor(() => expect(secureStore.deleteItemAsync).toHaveBeenCalledOnce());
      vi.mocked(Crypto.randomUUID).mockReturnValueOnce("newer-cleanup");
      newer = session.persistWhoopCleanupIntent();
      await Promise.resolve();
      expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
      finishDelete();
      await clearing;
      expect(storedValues.get(cleanupIntentKey)).toBe(await newer);
    } finally {
      finishDelete?.();
      await Promise.allSettled([clearing, newer]);
    }
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

  it("preserves live configuration when intent clearing is queued during its read", async () => {
    const cleanupIntentId = await session.persistWhoopCleanupIntent();
    let finishRead!: (value: string | null) => void;
    vi.mocked(secureStore.getItemAsync).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (finishRead = resolve)),
    );
    const checking = session.configureWhoopUploads(uploadContext);
    try {
      await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
      const clearing = session.clearWhoopCleanupIntent(cleanupIntentId);
      finishRead(cleanupIntentId);
      await clearing;
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
    expect(whoopBle.disableUploads).not.toHaveBeenCalled();

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
        finishRead?.("interrupted-cleanup");
        await expect(configuring).rejects.toThrow(/superseded/i);
        expect(whoopBle.configureUpload).not.toHaveBeenCalled();
      } finally {
        finishRead?.(null);
        await Promise.allSettled([configuring]);
      }
    },
  );
});
