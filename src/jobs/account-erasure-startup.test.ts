import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAccountErasureRestoreStartupGate } from "./account-erasure-startup.ts";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAccountErasureRestoreStartupGate", () => {
  it("fails closed and reports restore reconciliation failures", async () => {
    const failure = new Error("restore ledger unavailable");

    await expect(
      runAccountErasureRestoreStartupGate(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      tags: {
        workerStartupStep: "accountErasureRestoreReconciliation",
      },
    });
  });
});
