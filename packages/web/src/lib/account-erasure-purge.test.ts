// @vitest-environment jsdom
import { ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE } from "@dofek/auth/account-erasure";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installWebAccountPurgeListener,
  purgeWebAccountState,
  type WebAccountPurgeBroadcastChannel,
} from "./account-erasure-purge.ts";
import {
  ACCOUNT_ERASURE_LOCAL_CLEANUP_ACK_STORAGE_KEY,
  ACCOUNT_ERASURE_STATUS_STORAGE_KEY,
  saveAccountErasureStatusCapability,
} from "./account-erasure-storage.ts";
import { installTestWebAccountStateLocks } from "./web-account-state-lock.test-helpers.ts";
import { acquireWebAccountStateLock, withWebAccountStateLock } from "./web-account-state-lock.ts";

const mockDisablePostHog = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./posthog.ts", () => ({
  disablePostHogForAccountErasure: mockDisablePostHog,
}));

vi.mock("./telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

describe("purgeWebAccountState", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  beforeEach(() => {
    installTestWebAccountStateLocks();
    vi.clearAllMocks();
  });

  it("clears browser and query state while preserving only the public status capability", async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("dofek-private-dashboard", "cached");
    sessionStorage.setItem("dofek-auto-sync", "cached");
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    const clearQueries = vi.fn();
    const purgeUploads = vi.fn().mockResolvedValue(undefined);
    const deleteCache = vi.fn().mockResolvedValue(true);
    const cacheStorage = {
      delete: deleteCache,
      keys: vi.fn().mockResolvedValue(["dofek-assets", "other-cache"]),
    };

    await purgeWebAccountState({
      cacheStorage,
      cleanupLease,
      isCleanupLeaseCurrent: () => true,
      localStorage,
      purgeUploads,
      queryClient: { clear: clearQueries },
      sessionStorage,
    });

    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(ACCOUNT_ERASURE_STATUS_STORAGE_KEY)).toContain("s".repeat(43));
    expect(localStorage.getItem(ACCOUNT_ERASURE_STATUS_STORAGE_KEY)).toContain(
      "localCleanupGeneration",
    );
    expect(sessionStorage.getItem(ACCOUNT_ERASURE_LOCAL_CLEANUP_ACK_STORAGE_KEY)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(sessionStorage.length).toBe(1);
    expect(clearQueries).toHaveBeenCalledOnce();
    expect(purgeUploads).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledTimes(2);
  });

  it("attempts every cleanup target even when one target fails", async () => {
    const clearQueries = vi.fn();
    const purgeUploads = vi.fn().mockRejectedValue(new Error("IndexedDB unavailable"));
    const cacheStorage = {
      delete: vi.fn().mockResolvedValue(true),
      keys: vi.fn().mockResolvedValue(["dofek-assets"]),
    };

    const result = await purgeWebAccountState({
      cacheStorage,
      cleanupLease,
      isCleanupLeaseCurrent: () => true,
      localStorage,
      purgeUploads,
      queryClient: { clear: clearQueries },
      sessionStorage,
    });

    expect(result.errors).toHaveLength(1);
    expect(cacheStorage.delete).toHaveBeenCalledWith("dofek-assets");
    expect(clearQueries).toHaveBeenCalledOnce();
  });

  it("reports purge failures without sending account identifiers or capabilities", async () => {
    const secrets = {
      preparationToken: "private-preparation-token",
      statusToken: "private-status-token",
      userId: "private-user-id",
    };

    await purgeWebAccountState({
      cleanupLease,
      isCleanupLeaseCurrent: () => true,
      localStorage,
      purgeUploads: vi.fn().mockRejectedValue(new Error(JSON.stringify(secrets))),
      queryClient: { clear: vi.fn() },
      sessionStorage,
    });

    const telemetry = mockCaptureException.mock.calls
      .map(
        ([error, context]) =>
          `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(context)}`,
      )
      .join(" ");
    expect(telemetry).not.toContain(secrets.userId);
    expect(telemetry).not.toContain(secrets.statusToken);
    expect(telemetry).not.toContain(secrets.preparationToken);
  });

  it("asks other open Dofek tabs to purge before deleting local browser state", async () => {
    const channels: FakeBroadcastChannel[] = [];
    class FakeBroadcastChannel implements WebAccountPurgeBroadcastChannel {
      readonly #listeners = new Set<(event: MessageEvent) => void>();

      constructor() {
        channels.push(this);
      }

      addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
        this.#listeners.add(listener);
      }

      close(): void {}

      postMessage(message: unknown): void {
        for (const channel of channels) {
          if (channel === this) continue;
          for (const listener of channel.#listeners) {
            listener(new MessageEvent("message", { data: message }));
          }
        }
      }

      removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
        this.#listeners.delete(listener);
      }
    }
    const channelFactory = () => new FakeBroadcastChannel();
    const remoteQueryClear = vi.fn();
    const remoteUploadPurge = vi.fn().mockResolvedValue(undefined);
    const beginCleanup = vi.fn(async () => cleanupLease);
    const finishCleanup = vi.fn();
    const isCleanupLeaseCurrent = vi.fn(() => true);
    const removeListener = installWebAccountPurgeListener(
      { clear: remoteQueryClear },
      {
        beginAccountErasureCleanupForNonce: beginCleanup,
        channelFactory,
        finishAccountErasureCleanup: finishCleanup,
        isCleanupLeaseCurrent,
        purgeUploads: remoteUploadPurge,
      },
    );

    await purgeWebAccountState({
      channelFactory,
      cleanupLease,
      isCleanupLeaseCurrent,
      localStorage,
      purgeUploads: vi.fn().mockResolvedValue(undefined),
      queryClient: { clear: vi.fn() },
      sessionStorage,
    });

    await vi.waitFor(() => expect(remoteQueryClear).toHaveBeenCalledOnce());
    expect(remoteUploadPurge).toHaveBeenCalledOnce();
    expect(mockDisablePostHog).toHaveBeenCalledOnce();
    expect(beginCleanup).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce);
    expect(finishCleanup).toHaveBeenCalledWith(cleanupLease);
    removeListener();
  });

  it("replays a cleanup generation when a tab opens after the broadcast", async () => {
    const generation = "33333333-3333-4333-8333-333333333333";
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      localCleanupGeneration: generation,
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    class ReplayChannel implements WebAccountPurgeBroadcastChannel {
      addEventListener(): void {}
      close(): void {}
      postMessage(): void {}
      removeEventListener(): void {}
    }
    const channel = new ReplayChannel();
    const beginCleanup = vi.fn(async () => cleanupLease);
    const finishCleanup = vi.fn();
    const removeListener = installWebAccountPurgeListener(
      { clear: vi.fn() },
      {
        beginAccountErasureCleanupForNonce: beginCleanup,
        channelFactory: () => channel,
        finishAccountErasureCleanup: finishCleanup,
        isCleanupLeaseCurrent: () => true,
      },
    );

    await vi.waitFor(() =>
      expect(beginCleanup).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce),
    );
    expect(sessionStorage.getItem(ACCOUNT_ERASURE_LOCAL_CLEANUP_ACK_STORAGE_KEY)).toBe(generation);
    expect(finishCleanup).toHaveBeenCalledWith(cleanupLease);
    removeListener();
  });

  it("does not clear browser, upload, or query state for a stale account cleanup lease", async () => {
    localStorage.setItem("user-2-state", "preserve");
    sessionStorage.setItem("user-2-session-state", "preserve");
    const clearQueries = vi.fn();
    const purgeUploads = vi.fn();
    const cacheStorage = {
      delete: vi.fn(),
      keys: vi.fn(),
    };

    const result = await purgeWebAccountState({
      cacheStorage,
      cleanupLease,
      isCleanupLeaseCurrent: () => false,
      localStorage,
      purgeUploads,
      queryClient: { clear: clearQueries },
      sessionStorage,
    });

    expect(result.errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/another account became active/i),
    ]);
    expect(localStorage.getItem("user-2-state")).toBe("preserve");
    expect(sessionStorage.getItem("user-2-session-state")).toBe("preserve");
    expect(clearQueries).not.toHaveBeenCalled();
    expect(purgeUploads).not.toHaveBeenCalled();
    expect(cacheStorage.keys).not.toHaveBeenCalled();
  });

  it("does not let an arbitrarily delayed tab purge a later account generation", async () => {
    const channels: DelayedBroadcastChannel[] = [];
    const queuedMessages: Array<{
      message: unknown;
      sender: DelayedBroadcastChannel;
    }> = [];
    class DelayedBroadcastChannel implements WebAccountPurgeBroadcastChannel {
      readonly listeners = new Set<(event: MessageEvent) => void>();

      constructor() {
        channels.push(this);
      }

      addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
        this.listeners.add(listener);
      }

      close(): void {}

      postMessage(message: unknown): void {
        queuedMessages.push({ message, sender: this });
      }

      removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
        this.listeners.delete(listener);
      }
    }
    const channelFactory = () => new DelayedBroadcastChannel();
    const remoteQueryClear = vi.fn();
    let currentSessionNonce = cleanupLease.cleanupOwnerNonce;
    let remoteLock: Awaited<ReturnType<typeof acquireWebAccountStateLock>> | null = null;
    const removeListener = installWebAccountPurgeListener(
      { clear: remoteQueryClear },
      {
        beginAccountErasureCleanupForNonce: async (cleanupOwnerNonce) => {
          const stateLock = await acquireWebAccountStateLock();
          if (currentSessionNonce !== cleanupOwnerNonce) {
            stateLock.release();
            throw new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE);
          }
          remoteLock = stateLock;
          return cleanupLease;
        },
        channelFactory,
        finishAccountErasureCleanup: () => remoteLock?.release(),
        isCleanupLeaseCurrent: () => true,
        purgeUploads: vi.fn().mockResolvedValue(undefined),
      },
    );

    const originLock = await acquireWebAccountStateLock();
    await purgeWebAccountState({
      channelFactory,
      cleanupLease,
      isCleanupLeaseCurrent: () => true,
      localStorage,
      purgeUploads: vi.fn().mockResolvedValue(undefined),
      queryClient: { clear: vi.fn() },
      sessionStorage,
    });
    const laterSessionNonce = "33333333-3333-4333-8333-333333333333";
    const adoptLaterAccount = withWebAccountStateLock(async () => {
      currentSessionNonce = laterSessionNonce;
      localStorage.setItem("user-2-dashboard-cache", "private");
    });
    originLock.release();
    await adoptLaterAccount;

    for (const queued of queuedMessages.splice(0)) {
      for (const channel of channels) {
        if (channel === queued.sender) continue;
        for (const listener of channel.listeners) {
          listener(new MessageEvent("message", { data: queued.message }));
        }
      }
    }

    await vi.waitFor(() =>
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE,
        }),
        { source: "account-erasure-other-tab-purge" },
      ),
    );
    expect(remoteQueryClear).not.toHaveBeenCalled();
    expect(localStorage.getItem("user-2-dashboard-cache")).toBe("private");
    removeListener();
  });

  it("uses the browser BroadcastChannel fallback when no factory is supplied", async () => {
    const messages: unknown[] = [];
    let closed = false;
    class FallbackBroadcastChannel {
      addEventListener(): void {}
      close(): void {
        closed = true;
      }
      postMessage(message: unknown): void {
        messages.push(message);
      }
      removeEventListener(): void {}
    }
    vi.stubGlobal("BroadcastChannel", FallbackBroadcastChannel);

    try {
      await purgeWebAccountState({
        cleanupLease,
        isCleanupLeaseCurrent: () => true,
        localStorage,
        notifyOtherTabs: true,
        purgeUploads: vi.fn().mockResolvedValue(undefined),
        queryClient: { clear: vi.fn() },
        sessionStorage,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        cleanupGeneration: expect.any(String),
        cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
        kind: "purge",
        nonce: expect.any(String),
      }),
    );
    expect(closed).toBe(true);
  });

  it("records local cleanup errors and continues with the remaining stores", async () => {
    const clearLocalStorage = vi.fn(() => {
      throw new Error("local storage unavailable");
    });
    const failingLocalStorage: Storage = Object.create(localStorage);
    Object.defineProperties(failingLocalStorage, {
      clear: { configurable: true, value: clearLocalStorage },
      getItem: { configurable: true, value: (key: string) => localStorage.getItem(key) },
      setItem: {
        configurable: true,
        value: (key: string, value: string) => localStorage.setItem(key, value),
      },
    });
    const clearQueries = vi.fn();

    const result = await purgeWebAccountState({
      cleanupLease,
      isCleanupLeaseCurrent: () => true,
      localStorage: failingLocalStorage,
      notifyOtherTabs: false,
      purgeUploads: vi.fn().mockResolvedValue(undefined),
      queryClient: { clear: clearQueries },
      sessionStorage,
    });

    expect(result.errors.map((error) => error.message)).toEqual(["local storage unavailable"]);
    expect(clearQueries).toHaveBeenCalledOnce();
  });
});
