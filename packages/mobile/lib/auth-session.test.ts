import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  AFTER_FIRST_UNLOCK: "kSecAttrAccessibleAfterFirstUnlock",
}));
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn() }));

let SecureStore: typeof import("expo-secure-store");
let Crypto: typeof import("expo-crypto");
let storage: Map<string, string>;
const savedUser = { id: "u1", name: "Alice", email: "alice@example.com" };

let clearSessionToken: typeof import("./auth-session")["clearSessionToken"];
let getOrCreateSessionOwnerNonce: typeof import("./auth-session")["getOrCreateSessionOwnerNonce"];
let getSavedSessionUser: typeof import("./auth-session")["getSavedSessionUser"];
let getSessionToken: typeof import("./auth-session")["getSessionToken"];
let invalidateSessionPersistence: typeof import("./auth-session")["invalidateSessionPersistence"];
let rotateSessionOwnerNonce: typeof import("./auth-session")["rotateSessionOwnerNonce"];
let saveSessionToken: typeof import("./auth-session")["saveSessionToken"];
let saveSessionUser: typeof import("./auth-session")["saveSessionUser"];

function installSecureStoreFixture() {
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    storage.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    storage.delete(key);
  });
}

async function resetSessionModule() {
  vi.resetModules();
  const session = await import("./auth-session");
  clearSessionToken = session.clearSessionToken;
  getOrCreateSessionOwnerNonce = session.getOrCreateSessionOwnerNonce;
  getSavedSessionUser = session.getSavedSessionUser;
  getSessionToken = session.getSessionToken;
  invalidateSessionPersistence = session.invalidateSessionPersistence;
  rotateSessionOwnerNonce = session.rotateSessionOwnerNonce;
  saveSessionToken = session.saveSessionToken;
  saveSessionUser = session.saveSessionUser;
  SecureStore = await import("expo-secure-store");
  Crypto = await import("expo-crypto");
  vi.mocked(Crypto.randomUUID).mockReset().mockReturnValue("11111111-1111-4111-8111-111111111111");
  installSecureStoreFixture();
}

describe("session token storage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storage = new Map();
    await resetSessionModule();
  });

  it("saveSessionToken stores with AFTER_FIRST_UNLOCK accessibility", async () => {
    await saveSessionToken("my-token");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("dofek_session_token", "my-token", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });

  it.each(["stale-restored-token", "new-login-token"])(
    "deletes a deferred %s write after cleanup starts",
    async (token) => {
      storage.set("dofek_session_token", token);
      let resolveWrite: (() => void) | undefined;
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      const save = saveSessionToken(token);
      await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledOnce());

      const clear = clearSessionToken();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

      resolveWrite?.();
      await save;
      await clear;

      const tokenWriteOrder = vi.mocked(SecureStore.setItemAsync).mock.invocationCallOrder[0];
      const tokenDeleteCall = vi
        .mocked(SecureStore.deleteItemAsync)
        .mock.calls.findIndex(([key]) => key === "dofek_session_token");
      expect(tokenDeleteCall).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[tokenDeleteCall],
      ).toBeGreaterThan(tokenWriteOrder ?? 0);
    },
  );

  it("getSessionToken reads from the correct key", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce("stored-token");
    const token = await getSessionToken();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith("dofek_session_token");
    expect(token).toBe("stored-token");
  });

  it("getSessionToken returns cached token without hitting SecureStore again", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce("stored-token");
    await getSessionToken();
    await getSessionToken();

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it("does not cache a deferred token read that cleanup invalidates", async () => {
    let resolveRead: ((token: string) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const read = getSessionToken();
    await vi.waitFor(() => expect(SecureStore.getItemAsync).toHaveBeenCalledOnce());

    const clear = clearSessionToken();
    resolveRead?.("stale-token");

    await expect(read).resolves.toBeNull();
    await clear;
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(getSessionToken()).resolves.toBeNull();
  });

  it("getSessionToken throws when SecureStore is inaccessible", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error("User interaction is not allowed"),
    );

    await expect(getSessionToken()).rejects.toThrow("User interaction is not allowed");
  });

  it("retries SecureStore after a transient accessibility failure without caching null", async () => {
    vi.mocked(SecureStore.getItemAsync)
      .mockRejectedValueOnce(new Error("User interaction is not allowed"))
      .mockResolvedValueOnce("stored-token");

    await expect(getSessionToken()).rejects.toThrow("User interaction is not allowed");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);

    await expect(getSessionToken()).resolves.toBe("stored-token");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);

    await expect(getSessionToken()).resolves.toBe("stored-token");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it("clearSessionToken deletes the correct key", async () => {
    await clearSessionToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_owner_nonce_v1");
  });

  it("saves and restores only the user for the persisted session token", async () => {
    await saveSessionToken("saved-token");
    await saveSessionUser("saved-token", savedUser);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "dofek_session_user_v1",
      expect.any(String),
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
    await resetSessionModule();

    await expect(getSavedSessionUser("saved-token")).resolves.toEqual(savedUser);
    expect(storage.get("dofek_session_user_v1")).toBe(
      '{"id":"u1","name":"Alice","email":"alice@example.com"}',
    );
  });

  it("preserves the user while re-saving the same token for accessibility migration", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await saveSessionToken("saved-token");

    expect(storage.get("dofek_session_user_v1")).toBe(JSON.stringify(savedUser));
  });

  it("deletes the previous user before replacing the token", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "dofek_session_token") {
        expect(storage.has("dofek_session_user_v1")).toBe(false);
      }
      storage.set(key, value);
    });

    await saveSessionToken("new-token");

    expect(storage.get("dofek_session_token")).toBe("new-token");
    expect(storage.has("dofek_session_user_v1")).toBe(false);
  });

  it("keeps the previous token when deleting its user fails", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("keychain failure"));

    await expect(saveSessionToken("new-token")).rejects.toThrow("keychain failure");

    expect(storage.get("dofek_session_token")).toBe("old-token");
  });

  it("keeps the previous token when its saved user cannot be deleted while locked", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(
      new Error("User interaction is not allowed"),
    );

    await expect(saveSessionToken("new-token")).rejects.toThrow();

    expect(storage.get("dofek_session_token")).toBe("old-token");
  });

  it("leaves no saved identity when replacement stops after deleting the previous user", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("token write failed"));

    await expect(saveSessionToken("new-token")).rejects.toThrow("token write failed");
    await resetSessionModule();

    expect(storage.get("dofek_session_token")).toBe("old-token");
    await expect(getSavedSessionUser("old-token")).resolves.toBeNull();
  });

  it("does not restore another token's saved user", async () => {
    storage.set("dofek_session_token", "current-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await expect(getSavedSessionUser("previous-token")).resolves.toBeNull();
  });

  it("does not overwrite another token's saved user", async () => {
    storage.set("dofek_session_token", "current-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await saveSessionUser("previous-token", { id: "u2", name: "Bob", email: null });

    expect(storage.get("dofek_session_user_v1")).toBe(JSON.stringify(savedUser));
  });

  it("requires a persisted token before storing or restoring a user", async () => {
    await saveSessionUser("missing-token", savedUser);

    expect(storage.has("dofek_session_user_v1")).toBe(false);
    await expect(getSavedSessionUser("missing-token")).resolves.toBeNull();
  });

  it("requires online identity verification when only a token was saved before a restart", async () => {
    await saveSessionToken("saved-token");
    await resetSessionModule();

    await expect(getSavedSessionUser("saved-token")).resolves.toBeNull();
  });

  it.each(["not-json", '{"id":"u1"}', "null"])(
    "reports corrupted saved-user data and allows online recovery: %s",
    async (rawUser) => {
      storage.set("dofek_session_token", "saved-token");
      storage.set("dofek_session_user_v1", rawUser);

      await expect(getSavedSessionUser("saved-token")).resolves.toBeNull();
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        source: "auth-saved-user-restore",
      });
    },
  );

  it.each(["dofek_session_token", "dofek_session_user_v1"])(
    "propagates saved-user restore storage errors reading %s",
    async (unavailableKey) => {
      storage.set("dofek_session_token", "saved-token");
      storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
      const storageError = new Error("User interaction is not allowed");
      vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
        if (key === unavailableKey) throw storageError;
        return storage.get(key) ?? null;
      });

      await expect(getSavedSessionUser("saved-token")).rejects.toBe(storageError);
      expect(mockCaptureException).not.toHaveBeenCalled();
    },
  );

  it("clears the saved user with the token during logout", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await clearSessionToken();

    expect(storage.has("dofek_session_token")).toBe(false);
    expect(storage.has("dofek_session_user_v1")).toBe(false);
    await expect(getSavedSessionUser("saved-token")).resolves.toBeNull();
  });

  it("surfaces a saved-user deletion failure during logout", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "dofek_session_user_v1") {
        throw new Error("User interaction is not allowed");
      }
      storage.delete(key);
    });

    await expect(clearSessionToken()).rejects.toThrow("User interaction is not allowed");
  });

  it.each(["dofek_session_token", "dofek_session_user_v1"])(
    "does not restore a user when cleanup invalidates its %s read",
    async (deferredKey) => {
      storage.set("dofek_session_token", "saved-token");
      storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
      let resolveRead: ((value: string | null) => void) | undefined;
      vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
        if (key === deferredKey) {
          return new Promise<string | null>((resolve) => {
            resolveRead = resolve;
          });
        }
        return storage.get(key) ?? null;
      });

      const read = getSavedSessionUser("saved-token");
      await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
      invalidateSessionPersistence();
      resolveRead?.(storage.get(deferredKey) ?? null);

      await expect(read).resolves.toBeNull();
    },
  );

  it("does not save a user when cleanup invalidates its token read", async () => {
    storage.set("dofek_session_token", "saved-token");
    let resolveRead: ((value: string | null) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const write = saveSessionUser("saved-token", savedUser);
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    invalidateSessionPersistence();
    resolveRead?.("saved-token");
    await write;

    expect(storage.has("dofek_session_user_v1")).toBe(false);
  });

  it("does not run queued saved-user operations after cleanup invalidates them", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    let resolveRead: ((value: string | null) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const blockingRead = getSessionToken();
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    const queuedRead = getSavedSessionUser("saved-token");
    const queuedWrite = saveSessionUser("saved-token", { id: "u2", name: "Bob", email: null });

    const clear = clearSessionToken();
    resolveRead?.("saved-token");
    await Promise.all([blockingRead, queuedWrite, clear]);

    await expect(queuedRead).resolves.toBeNull();
    expect(storage.has("dofek_session_user_v1")).toBe(false);
    expect(
      SecureStore.setItemAsync.mock.calls.some(([key]) => key === "dofek_session_user_v1"),
    ).toBe(false);
  });

  it("deletes an in-flight saved-user write after cleanup starts", async () => {
    storage.set("dofek_session_token", "saved-token");
    let resolveWrite: (() => void) | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          resolveWrite = () => {
            storage.set(key, value);
            resolve();
          };
        }),
    );
    const write = saveSessionUser("saved-token", savedUser);
    await vi.waitFor(() => expect(resolveWrite).toBeTypeOf("function"));

    const clear = clearSessionToken();
    resolveWrite?.();
    await Promise.all([write, clear]);

    expect(storage.has("dofek_session_user_v1")).toBe(false);
  });

  it("rotates an opaque owner nonce for each adopted session", async () => {
    await expect(rotateSessionOwnerNonce()).resolves.toBe("11111111-1111-4111-8111-111111111111");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "dofek_session_owner_nonce_v1",
      "11111111-1111-4111-8111-111111111111",
      expect.any(Object),
    );
  });

  it("restores the persisted owner nonce after an app restart", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(
      "11111111-1111-4111-8111-111111111111",
    );

    await expect(getOrCreateSessionOwnerNonce()).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("deletes a deferred owner-nonce write after cleanup starts", async () => {
    let resolveWrite: (() => void) | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const rotate = rotateSessionOwnerNonce();
    await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledOnce());

    const clear = clearSessionToken();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    resolveWrite?.();
    await rotate;
    await clear;
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_owner_nonce_v1");
  });
});

describe("native upload signout boundary", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storage = new Map();
    await resetSessionModule();
    const native = await import("../modules/whoop-ble");
    vi.mocked(native.disableUploads).mockReset().mockResolvedValue(undefined);
  });
  it("persists replacement credentials while native cleanup is pending and preserves them after completion", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    const previousUser = { id: "previous-user", name: "Previous", email: null };
    const persisted = new Map<string, string>([
      ["dofek_session_token", "previous-session"],
      ["dofek_session_user_v1", JSON.stringify(previousUser)],
      ["dofek_session_owner_nonce_v1", "previous-owner-nonce"],
    ]);
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(native.disableUploads).mockImplementationOnce(() => pending);
    let cleanupSettled = false;
    const clearing = clearSessionToken().finally(() => {
      cleanupSettled = true;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await vi.waitFor(() => {
        expect(persisted.has("dofek_session_token")).toBe(false);
        expect(persisted.has("dofek_session_user_v1")).toBe(false);
        expect(persisted.has("dofek_session_owner_nonce_v1")).toBe(false);
      });
      expect(cleanupSettled).toBe(false);

      const replacementToken = "replacement-session";
      const replacementUser = { id: "replacement-user", name: "Replacement", email: null };
      const saving = saveSessionToken(replacementToken);
      operations.push(saving);
      const savingUser = saveSessionUser(replacementToken, replacementUser);
      operations.push(savingUser);
      const rotatingNonce = rotateSessionOwnerNonce();
      operations.push(rotatingNonce);
      await vi.waitFor(() => {
        expect(persisted.get("dofek_session_token")).toBe(replacementToken);
        expect(persisted.get("dofek_session_user_v1")).toBe(JSON.stringify(replacementUser));
        expect(persisted.get("dofek_session_owner_nonce_v1")).toBe(
          "11111111-1111-4111-8111-111111111111",
        );
      });

      expect(cleanupSettled).toBe(false);
    } finally {
      finish();
      await clearing;
      await Promise.allSettled(operations);
    }
    expect(cleanupSettled).toBe(true);
    expect(persisted.get("dofek_session_token")).toBe("replacement-session");
    expect(persisted.get("dofek_session_user_v1")).toBe(
      JSON.stringify({ id: "replacement-user", name: "Replacement", email: null }),
    );
    expect(persisted.get("dofek_session_owner_nonce_v1")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    const tokenReadCount = vi
      .mocked(storage.getItemAsync)
      .mock.calls.filter(([key]) => key === "dofek_session_token").length;
    await expect(getSessionToken()).resolves.toBe("replacement-session");
    expect(
      vi.mocked(storage.getItemAsync).mock.calls.filter(([key]) => key === "dofek_session_token"),
    ).toHaveLength(tokenReadCount);
  });
  it("preserves replacement credentials after late native cleanup rejection", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    const persisted = new Map<string, string>();
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    let rejectCleanup!: (error: Error) => void;
    const pendingCleanup = new Promise<void>((_resolve, reject) => (rejectCleanup = reject));
    const nativeFailure = new Error("Native queue could not be purged");
    vi.mocked(native.disableUploads).mockImplementationOnce(() => pendingCleanup);
    const clearing = clearSessionToken().then(
      () => null,
      (error: unknown) => error,
    );
    const operations: Promise<unknown>[] = [];
    try {
      await vi.waitFor(() => {
        expect(persisted.has("dofek_session_token")).toBe(false);
        expect(persisted.has("dofek_session_user_v1")).toBe(false);
        expect(persisted.has("dofek_session_owner_nonce_v1")).toBe(false);
      });
      const saving = saveSessionToken("replacement-session");
      operations.push(saving);
      const savingUser = saveSessionUser("replacement-session", savedUser);
      operations.push(savingUser);
      const rotating = rotateSessionOwnerNonce();
      operations.push(rotating);
      await vi.waitFor(() => {
        expect(persisted.get("dofek_session_token")).toBe("replacement-session");
        expect(persisted.get("dofek_session_user_v1")).toBe(JSON.stringify(savedUser));
      });
      expect(persisted.has("dofek_whoop_cleanup_intent_v1")).toBe(true);
    } finally {
      rejectCleanup(nativeFailure);
      await clearing;
      await Promise.allSettled(operations);
    }
    expect(await clearing).toBe(nativeFailure);
    expect(mockCaptureException).toHaveBeenCalledWith(nativeFailure, {
      source: "auth-session-cleanup",
      retiredLifetime: true,
    });
    const tokenReads = vi
      .mocked(storage.getItemAsync)
      .mock.calls.filter(([key]) => key === "dofek_session_token").length;
    await expect(getSessionToken()).resolves.toBe("replacement-session");
    expect(
      vi.mocked(storage.getItemAsync).mock.calls.filter(([key]) => key === "dofek_session_token"),
    ).toHaveLength(tokenReads);
  });
  it("holds token adoption until native success when intent persistence fails", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    const persisted = new Map<string, string>();
    const intentFailure = new Error("Cleanup intent could not be saved");
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "dofek_whoop_cleanup_intent_v1") throw intentFailure;
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    let finishCleanup!: () => void;
    const pendingCleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
    vi.mocked(native.disableUploads).mockImplementationOnce(() => pendingCleanup);
    const clearing = clearSessionToken().then(
      () => null,
      (error: unknown) => error,
    );
    const saving = saveSessionToken("replacement-session");
    try {
      await vi.waitFor(() => {
        expect(storage.setItemAsync).toHaveBeenCalledWith(
          "dofek_whoop_cleanup_intent_v1",
          expect.any(String),
          expect.any(Object),
        );
        expect(storage.deleteItemAsync).toHaveBeenCalledWith("dofek_session_token");
      });
      expect(storage.setItemAsync).not.toHaveBeenCalledWith(
        "dofek_session_token",
        "replacement-session",
        expect.any(Object),
      );
    } finally {
      finishCleanup();
      await Promise.allSettled([clearing, saving]);
    }
    expect(await clearing).toBe(intentFailure);
    await expect(saving).resolves.toBeUndefined();
    expect(persisted.get("dofek_session_token")).toBe("replacement-session");
  });
  it("deletes persisted credentials even when native disable fails", async () => {
    const native = await import("../modules/whoop-ble");
    const secureStore = await import("expo-secure-store");
    const persisted = new Map<string, string>([
      ["dofek_session_token", "token"],
      ["dofek_session_user_v1", JSON.stringify({ id: "user", name: "User", email: null })],
      ["dofek_session_owner_nonce_v1", "owner"],
    ]);
    vi.clearAllMocks();
    vi.mocked(secureStore.getItemAsync).mockImplementation(
      async (key) => persisted.get(key) ?? null,
    );
    vi.mocked(secureStore.setItemAsync).mockImplementation(async (key, value) => {
      persisted.set(key, value);
    });
    vi.mocked(secureStore.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    vi.mocked(native.disableUploads).mockRejectedValueOnce(
      new Error("Native queue could not be purged"),
    );
    await expect(clearSessionToken()).rejects.toThrow("Native queue could not be purged");
    expect(persisted.has("dofek_session_token")).toBe(false);
    expect(persisted.has("dofek_session_user_v1")).toBe(false);
    expect(persisted.has("dofek_session_owner_nonce_v1")).toBe(false);
    expect(persisted.get("dofek_whoop_cleanup_intent_v1")).toBeTypeOf("string");
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(secureStore.deleteItemAsync).mock.invocationCallOrder.at(-1) ?? 0,
    );
    storage = persisted;
    await resetSessionModule();
    await expect(getSessionToken()).resolves.toBeNull();
  });
  it("reports a null cleanup-intent write rejection after native cleanup succeeds", async () => {
    const storage = await import("expo-secure-store");
    const persisted = new Map<string, string>();
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "dofek_whoop_cleanup_intent_v1") throw null;
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });

    await expect(clearSessionToken()).rejects.toBeNull();

    expect(mockCaptureException).toHaveBeenCalledWith(null, {
      source: "auth-session-cleanup",
      retiredLifetime: true,
    });
  });
  it("keeps replacement adoption fenced when writing the cleanup intent and native cleanup both fail", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    const persisted = new Map<string, string>();
    const intentFailure = new Error("Cleanup intent could not be saved");
    const nativeFailure = new Error("Native queue could not be purged");
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      persisted.set(key, value);
    });
    vi.mocked(storage.setItemAsync).mockImplementationOnce(async (key, value) => {
      if (key === "dofek_whoop_cleanup_intent_v1") throw intentFailure;
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    let finishRecovery!: () => void;
    const pendingRecovery = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    vi.mocked(native.disableUploads)
      .mockRejectedValueOnce(nativeFailure)
      .mockImplementationOnce(() => pendingRecovery);

    const cleanupError = await clearSessionToken().then(
      () => null,
      (error: unknown) => error,
    );
    const adoptionError = await saveSessionToken("replacement-session").then(
      () => null,
      (error: unknown) => error,
    );

    expect(cleanupError).toMatchObject({ errors: [intentFailure, nativeFailure] });
    expect(adoptionError).toBe(nativeFailure);
    expect(persisted.has("dofek_session_token")).toBe(false);

    let recoverySettled = false;
    const recoveryCleanup = clearSessionToken().finally(() => {
      recoverySettled = true;
    });
    const recoverySave = saveSessionToken("replacement-session");
    try {
      await vi.waitFor(() => {
        expect(persisted.get("dofek_session_token")).toBe("replacement-session");
        expect(persisted.get("dofek_whoop_cleanup_intent_v1")).toBeTypeOf("string");
      });
      expect(recoverySettled).toBe(false);
      expect(native.disableUploads).toHaveBeenCalledTimes(2);
    } finally {
      finishRecovery();
      await Promise.allSettled([recoveryCleanup, recoverySave]);
    }
    expect(recoverySettled).toBe(true);
    expect(native.disableUploads).toHaveBeenCalledTimes(2);
  });
  it("does not let an older cleanup completion clear a newer intent", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    const persisted = new Map<string, string>();
    vi.mocked(storage.getItemAsync).mockImplementation(async (key) => persisted.get(key) ?? null);
    vi.mocked(storage.setItemAsync).mockImplementation(async (key, value) => {
      persisted.set(key, value);
    });
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      persisted.delete(key);
    });
    vi.mocked(Crypto.randomUUID)
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const finishers: (() => void)[] = [];
    vi.mocked(native.disableUploads).mockImplementation(
      () => new Promise<void>((resolve) => finishers.push(resolve)),
    );
    const cleanups: Promise<void>[] = [];
    try {
      const cleanupA = clearSessionToken();
      cleanups.push(cleanupA);
      await vi.waitFor(() =>
        expect(persisted.get("dofek_whoop_cleanup_intent_v1")).toBeTypeOf("string"),
      );
      const intentA = persisted.get("dofek_whoop_cleanup_intent_v1");

      const cleanupB = clearSessionToken();
      cleanups.push(cleanupB);
      await vi.waitFor(() => {
        expect(persisted.get("dofek_whoop_cleanup_intent_v1")).toBeTypeOf("string");
        expect(persisted.get("dofek_whoop_cleanup_intent_v1")).not.toBe(intentA);
      });
      const intentB = persisted.get("dofek_whoop_cleanup_intent_v1");

      finishers[0]?.();
      await cleanupA;
      expect(persisted.get("dofek_whoop_cleanup_intent_v1")).toBe(intentB);

      finishers[1]?.();
      await cleanupB;
      expect(persisted.has("dofek_whoop_cleanup_intent_v1")).toBe(false);
    } finally {
      for (const finish of finishers) finish();
      await Promise.allSettled(cleanups);
    }
  });
  it("preserves native and credential cleanup failures after attempting every deletion", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    vi.clearAllMocks();
    const nativeFailure = new Error("Native queue could not be purged");
    const credentialFailure = new Error("Keychain unavailable");
    vi.mocked(native.disableUploads).mockRejectedValueOnce(nativeFailure);
    vi.mocked(storage.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "dofek_session_token") throw credentialFailure;
    });
    const clearing = clearSessionToken();
    await expect(clearing).rejects.toMatchObject({ errors: [nativeFailure, credentialFailure] });
    expect(storage.deleteItemAsync).toHaveBeenCalledWith("dofek_session_user_v1");
    expect(storage.deleteItemAsync).toHaveBeenCalledWith("dofek_session_owner_nonce_v1");
  });
  it("disables native upload before credential deletion can await", async () => {
    const native = await import("../modules/whoop-ble");
    const storage = await import("expo-secure-store");
    vi.clearAllMocks();
    const clearing = clearSessionToken();
    expect(native.disableUploads).toHaveBeenCalledOnce();
    await clearing;
    expect(vi.mocked(native.disableUploads).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(storage.deleteItemAsync).mock.invocationCallOrder[0] ?? 0,
    );
  });
});
