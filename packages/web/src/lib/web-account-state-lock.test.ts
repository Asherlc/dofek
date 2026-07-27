// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { installTestWebAccountStateLocks } from "./web-account-state-lock.test-helpers.ts";
import { acquireWebAccountStateLock } from "./web-account-state-lock.ts";

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
