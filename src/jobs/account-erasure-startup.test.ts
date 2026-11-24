import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAccountErasureLedgerKeyring } from "../account-erasure/identity.ts";
import { createEncryptedAccountErasureSnapshot } from "../account-erasure/remote-snapshot.ts";
import { createAccountErasureRestoreLedgerFromEnv } from "../account-erasure/restore-ledger.ts";
import { reconcileAccountErasureRestoreIntents } from "../account-erasure/restore-reconciliation.ts";
import { createMockDatabase } from "../providers/test-helpers.ts";
import {
  prepareProviderWorker,
  runAccountErasureRestoreStartupGate,
} from "./account-erasure-startup.ts";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("../account-erasure/identity.ts", () => ({ validateAccountErasureLedgerKeyring: vi.fn() }));
vi.mock("../account-erasure/remote-snapshot.ts", () => ({
  createEncryptedAccountErasureSnapshot: vi.fn(),
}));
vi.mock("../account-erasure/restore-ledger.ts", () => ({
  createAccountErasureRestoreLedgerFromEnv: vi.fn(),
}));
vi.mock("../account-erasure/restore-reconciliation.ts", () => ({
  reconcileAccountErasureRestoreIntents: vi.fn(),
}));
vi.mock("./provider-registration.ts", () => ({ ensureProvidersRegistered: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("prepareProviderWorker", () => {
  it("validates the keyring and supplies the encrypted snapshot callback before consuming work", async () => {
    const { db } = createMockDatabase();
    const ledger = {
      findIntent: vi.fn(),
      listIntentReferences: vi.fn(),
      listIntentsForIdentities: vi.fn(),
      recordIntent: vi.fn(),
    };
    vi.mocked(createAccountErasureRestoreLedgerFromEnv).mockReturnValueOnce(ledger);
    vi.mocked(createEncryptedAccountErasureSnapshot).mockResolvedValueOnce("encrypted-snapshot");
    vi.mocked(reconcileAccountErasureRestoreIntents).mockImplementationOnce(async (inputs) => {
      expect(inputs.database).toBe(db);
      expect(inputs.ledger).toBe(ledger);
      await db.transaction(async (transaction) => {
        const snapshot = await inputs.createEncryptedRemoteSnapshot(transaction, "fixture-user");
        expect(snapshot).toBe("encrypted-snapshot");
        expect(createEncryptedAccountErasureSnapshot).toHaveBeenCalledWith(
          transaction,
          "fixture-user",
          expect.any(Array),
        );
      });
      return { recoveredRequestIds: [] };
    });

    await prepareProviderWorker(db);

    expect(validateAccountErasureLedgerKeyring).toHaveBeenCalledBefore(
      vi.mocked(createAccountErasureRestoreLedgerFromEnv),
    );
    expect(reconcileAccountErasureRestoreIntents).toHaveBeenCalledOnce();
  });
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
