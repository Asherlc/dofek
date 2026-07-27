import { ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE } from "@dofek/auth/account-erasure";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  ACCOUNT_ERASURE_STATUS_STORAGE_KEY,
  loadAccountErasureStatusCapability,
} from "./account-erasure-storage.ts";
import type { AccountErasureCleanupLease } from "./auth-context.tsx";
import { disablePostHogForAccountErasure } from "./posthog.ts";
import { deleteIndexedDbUploadDatabase } from "./resumable-file-upload.ts";
import { captureException } from "./telemetry.ts";

interface QueryState {
  clear(): void;
}

interface BrowserCacheStorage {
  delete(cacheName: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

export interface WebAccountPurgeBroadcastChannel {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

type WebAccountPurgeBroadcastChannelFactory = (
  channelName: string,
) => WebAccountPurgeBroadcastChannel;

interface PurgeWebAccountStateOptions {
  cacheStorage?: BrowserCacheStorage | undefined;
  channelFactory?: WebAccountPurgeBroadcastChannelFactory | undefined;
  cleanupLease: AccountErasureCleanupLease;
  isCleanupLeaseCurrent: (lease: AccountErasureCleanupLease) => boolean;
  localStorage?: Storage | undefined;
  notifyOtherTabs?: boolean | undefined;
  purgeUploads?: (() => Promise<void>) | undefined;
  queryClient: Pick<QueryClient, "clear"> | QueryState;
  sessionStorage?: Storage | undefined;
}

export interface WebAccountPurgeResult {
  errors: Error[];
}

function reportAccountPurgeFailure(source: string): void {
  captureException(new Error("Local account erasure cleanup failed."), {
    source,
  });
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const ACCOUNT_PURGE_CHANNEL_NAME = "dofek-account-purge-v1";
const purgeRequestSchema = z.object({
  cleanupOwnerNonce: z.uuid(),
  kind: z.literal("purge"),
  nonce: z.string().min(1),
});

function createBrowserChannel(channelName: string): WebAccountPurgeBroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(channelName);
  return {
    addEventListener: (_type, listener) => channel.addEventListener("message", listener),
    close: () => channel.close(),
    postMessage: (message) => channel.postMessage(message),
    removeEventListener: (_type, listener) => channel.removeEventListener("message", listener),
  };
}

function requestOtherTabsToPurge(
  options: Pick<PurgeWebAccountStateOptions, "channelFactory" | "cleanupLease">,
): void {
  const channel =
    options.channelFactory?.(ACCOUNT_PURGE_CHANNEL_NAME) ??
    createBrowserChannel(ACCOUNT_PURGE_CHANNEL_NAME);
  if (!channel) return;
  const nonce = crypto.randomUUID();
  channel.postMessage({
    cleanupOwnerNonce: options.cleanupLease.cleanupOwnerNonce,
    kind: "purge",
    nonce,
  });
  channel.close();
}

export async function purgeWebAccountState(
  options: PurgeWebAccountStateOptions,
): Promise<WebAccountPurgeResult> {
  const localStore = options.localStorage ?? window.localStorage;
  const sessionStore = options.sessionStorage ?? window.sessionStorage;
  const cacheStore =
    options.cacheStorage ??
    (typeof window !== "undefined" && "caches" in window ? window.caches : undefined);
  const purgeUploads = options.purgeUploads ?? deleteIndexedDbUploadDatabase;
  const errors: Error[] = [];
  let ownershipFailureReported = false;
  const canContinue = (): boolean => {
    if (options.isCleanupLeaseCurrent(options.cleanupLease)) return true;
    if (!ownershipFailureReported) {
      ownershipFailureReported = true;
      errors.push(new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE));
      captureException(new Error("Local account erasure cleanup ownership changed."), {
        source: "account-erasure-cleanup-ownership",
      });
    }
    return false;
  };

  const attempt = async (source: string, operation: () => void | Promise<void>) => {
    if (!canContinue()) return;
    try {
      await operation();
    } catch (error: unknown) {
      const normalized = errorFromUnknown(error);
      errors.push(normalized);
      reportAccountPurgeFailure(source);
    }
  };

  const statusCapability = loadAccountErasureStatusCapability(localStore);
  if (!canContinue()) return { errors };

  if (options.notifyOtherTabs !== false) {
    requestOtherTabsToPurge(options);
  }
  if (!canContinue()) return { errors };

  await attempt("account-erasure-local-storage-purge", () => {
    localStore.clear();
    if (statusCapability) {
      localStore.setItem(ACCOUNT_ERASURE_STATUS_STORAGE_KEY, JSON.stringify(statusCapability));
    }
  });
  await attempt("account-erasure-session-storage-purge", () => sessionStore.clear());
  await attempt("account-erasure-query-cache-purge", () => options.queryClient.clear());
  await Promise.all([
    attempt("account-erasure-upload-cache-purge", purgeUploads),
    attempt("account-erasure-cache-storage-purge", async () => {
      if (!cacheStore) return;
      const cacheNames = await cacheStore.keys();
      await Promise.all(cacheNames.map((cacheName) => cacheStore.delete(cacheName)));
    }),
  ]);

  return { errors };
}

export function installWebAccountPurgeListener(
  queryClient: Pick<QueryClient, "clear"> | QueryState,
  options: Omit<PurgeWebAccountStateOptions, "cleanupLease" | "notifyOtherTabs" | "queryClient"> & {
    beginAccountErasureCleanupForNonce: (
      cleanupOwnerNonce: string,
    ) => Promise<AccountErasureCleanupLease>;
    finishAccountErasureCleanup: (lease: AccountErasureCleanupLease) => void;
  },
): () => void {
  const channel =
    options.channelFactory?.(ACCOUNT_PURGE_CHANNEL_NAME) ??
    createBrowserChannel(ACCOUNT_PURGE_CHANNEL_NAME);
  if (!channel) return () => undefined;

  const listener = (event: MessageEvent) => {
    const request = purgeRequestSchema.safeParse(event.data);
    if (!request.success) return;
    void (async () => {
      let cleanupLease: AccountErasureCleanupLease | null = null;
      try {
        cleanupLease = await options.beginAccountErasureCleanupForNonce(
          request.data.cleanupOwnerNonce,
        );
        if (options.isCleanupLeaseCurrent(cleanupLease)) {
          disablePostHogForAccountErasure();
        }
        await purgeWebAccountState({
          ...options,
          cleanupLease,
          notifyOtherTabs: false,
          queryClient,
        });
      } catch (error: unknown) {
        captureException(error, { source: "account-erasure-other-tab-purge" });
      } finally {
        if (cleanupLease) {
          options.finishAccountErasureCleanup(cleanupLease);
        }
      }
    })();
  };
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}
