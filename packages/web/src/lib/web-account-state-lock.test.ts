// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { installTestWebAccountStateLocks } from "./web-account-state-lock.test-helpers.ts";
import {
  acquireWebAccountStateLock,
  WEB_ACCOUNT_STATE_LOCK_UNAVAILABLE_MESSAGE,
  webAccountStateLocksAreAvailable,
  withWebAccountStateLock,
  withWebAccountStateLockWhenAvailable,
} from "./web-account-state-lock.ts";

beforeEach(installTestWebAccountStateLocks);

it("serializes account-state operations without a timing window", async () => {
  const first = await acquireWebAccountStateLock();
  let secondAcquired = false;
  const second = acquireWebAccountStateLock().then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(secondAcquired).toBe(false);

  first.release();
  const secondLease = await second;
  expect(secondAcquired).toBe(true);
  secondLease.release();
});

it("fails clearly and uses the fallback when Web Locks are unavailable", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });

  expect(webAccountStateLocksAreAvailable()).toBe(false);
  await expect(acquireWebAccountStateLock()).rejects.toThrow(
    WEB_ACCOUNT_STATE_LOCK_UNAVAILABLE_MESSAGE,
  );
  await expect(withWebAccountStateLockWhenAvailable(async () => "fallback")).resolves.toBe(
    "fallback",
  );
});

it("propagates lock-manager failures before acquisition", async () => {
  const error = new Error("lock manager unavailable");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: vi.fn().mockRejectedValue(error) },
  });

  await expect(acquireWebAccountStateLock()).rejects.toBe(error);
});

it("releases the browser lock once even when the lease is released repeatedly", async () => {
  let callbackFinished = false;
  const request = vi.fn(
    async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => Promise<void>,
    ): Promise<void> => {
      await callback({ mode: "exclusive", name: "dofek-account-state-v1" });
      callbackFinished = true;
    },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });

  const lease = await acquireWebAccountStateLock();
  lease.release();
  lease.release();
  await vi.waitFor(() => expect(callbackFinished).toBe(true));
  expect(request).toHaveBeenCalledOnce();
});

it("releases the browser lock when the operation fails", async () => {
  let callbackFinished = false;
  const request = vi.fn(
    async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => Promise<void>,
    ): Promise<void> => {
      await callback({ mode: "exclusive", name: "dofek-account-state-v1" });
      callbackFinished = true;
    },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });

  await expect(
    withWebAccountStateLock(async () => Promise.reject(new Error("operation failed"))),
  ).rejects.toThrow("operation failed");
  expect(callbackFinished).toBe(true);
});
