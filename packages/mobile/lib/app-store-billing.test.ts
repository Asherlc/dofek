import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppStoreProduct,
  AppStorePurchaseResult,
  AppStoreTransaction,
} from "../modules/app-store-billing";

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  type AppStoreBillingNative,
  AppStoreBillingService,
  type AppStoreBillingTrpcClient,
  useAppStoreBillingTransactionUpdates,
} from "./app-store-billing";

const purchaseTransaction: AppStoreTransaction = {
  transactionID: "transaction-1",
  productID: "com.dofek.premium.monthly",
  signedTransaction: "verified-jws",
};

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  if (!resolve || !reject) throw new Error("Deferred promise was not initialized.");
  return { promise, reject, resolve };
}

function createFixture(options?: {
  product?: AppStoreProduct | null;
  purchaseResult?: AppStorePurchaseResult;
  restoredTransactions?: AppStoreTransaction[];
}) {
  let transactionUpdateListener: ((transaction: AppStoreTransaction) => void) | null = null;
  const updateSubscription = { remove: vi.fn() };
  const native: AppStoreBillingNative = {
    loadProduct: vi.fn().mockResolvedValue(options?.product ?? null),
    purchase: vi.fn().mockResolvedValue(
      options?.purchaseResult ?? {
        outcome: "verified",
        ...purchaseTransaction,
      },
    ),
    restoreCurrentEntitlements: vi.fn().mockResolvedValue(options?.restoredTransactions ?? []),
    startTransactionUpdates: vi.fn((listener) => {
      transactionUpdateListener = listener;
      return updateSubscription;
    }),
    stopTransactionUpdates: vi.fn(),
    finishTransaction: vi.fn().mockResolvedValue(undefined),
    showManageSubscriptions: vi.fn().mockResolvedValue(undefined),
  };
  const trpcClient: AppStoreBillingTrpcClient = {
    billing: {
      appStorePurchaseContext: {
        query: vi.fn().mockResolvedValue({
          productId: "com.dofek.premium.monthly",
          appAccountToken: "00000000-0000-4000-8000-000000000001",
        }),
      },
      verifyAppStoreTransaction: {
        mutate: vi.fn().mockResolvedValue({ hasFullAccess: true }),
      },
    },
  };
  const queryClient = new QueryClient();
  const billingStatusQueryKey = [["billing", "status"], { type: "query" }] as const;
  queryClient.setQueryData(billingStatusQueryKey, { hasFullAccess: false });
  const service = new AppStoreBillingService({ native, queryClient, trpcClient });

  return {
    billingStatusQueryKey,
    native,
    queryClient,
    service,
    trpcClient,
    updateSubscription,
    emitTransactionUpdate: (transaction: AppStoreTransaction) => {
      if (!transactionUpdateListener) throw new Error("Transaction updates were not started.");
      transactionUpdateListener(transaction);
    },
  };
}

describe("AppStoreBillingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the localized StoreKit product price", async () => {
    const product = {
      productID: "com.dofek.premium.monthly",
      displayName: "Dofek Premium",
      description: "Full access",
      displayPrice: "€4.99",
    };
    const fixture = createFixture({ product });

    await expect(fixture.service.loadProduct()).resolves.toEqual(product);
    expect(fixture.native.loadProduct).toHaveBeenCalledWith("com.dofek.premium.monthly");
  });

  it("finishes a purchase only after server verification succeeds", async () => {
    const fixture = createFixture();
    const verification = createDeferred<unknown>();
    vi.mocked(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).mockReturnValueOnce(
      verification.promise,
    );

    const subscription = fixture.service.subscribe();

    await vi.waitFor(() => {
      expect(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).toHaveBeenCalledWith({
        signedTransaction: "verified-jws",
      });
    });
    expect(fixture.native.finishTransaction).not.toHaveBeenCalled();

    verification.resolve({ hasFullAccess: true });
    await expect(subscription).resolves.toEqual({
      outcome: "verified",
      ...purchaseTransaction,
    });
    expect(fixture.native.finishTransaction).toHaveBeenCalledWith("transaction-1");
  });

  it("uses the server purchase context for the native purchase", async () => {
    const fixture = createFixture();

    await fixture.service.subscribe();

    expect(fixture.native.purchase).toHaveBeenCalledWith(
      "com.dofek.premium.monthly",
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("does not finish or invalidate when the server rejects a purchase", async () => {
    const fixture = createFixture();
    const rejection = new Error("Transaction belongs to another Dofek account.");
    vi.mocked(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).mockRejectedValueOnce(
      rejection,
    );

    await expect(fixture.service.subscribe()).rejects.toBe(rejection);

    expect(fixture.native.finishTransaction).not.toHaveBeenCalled();
    expect(fixture.queryClient.getQueryState(fixture.billingStatusQueryKey)?.isInvalidated).toBe(
      false,
    );
    expect(mockCaptureException).toHaveBeenCalledWith(rejection, {
      source: "app-store-billing-subscribe",
    });
  });

  it("treats purchase cancellation as a successful user outcome", async () => {
    const fixture = createFixture({ purchaseResult: { outcome: "cancelled" } });

    await expect(fixture.service.subscribe()).resolves.toEqual({ outcome: "cancelled" });

    expect(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).not.toHaveBeenCalled();
    expect(fixture.native.finishTransaction).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("invalidates billing status after an accepted purchase is finished", async () => {
    const fixture = createFixture();

    await fixture.service.subscribe();

    expect(fixture.queryClient.getQueryState(fixture.billingStatusQueryKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("verifies and finishes every restored current entitlement", async () => {
    const restoredTransactions = [
      purchaseTransaction,
      {
        ...purchaseTransaction,
        transactionID: "transaction-2",
        signedTransaction: "restored-jws",
      },
    ];
    const fixture = createFixture({ restoredTransactions });

    await expect(fixture.service.restore()).resolves.toBe(2);

    expect(fixture.native.restoreCurrentEntitlements).toHaveBeenCalledWith(
      "com.dofek.premium.monthly",
    );
    expect(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).toHaveBeenNthCalledWith(1, {
      signedTransaction: "verified-jws",
    });
    expect(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).toHaveBeenNthCalledWith(2, {
      signedTransaction: "restored-jws",
    });
    expect(fixture.native.finishTransaction).toHaveBeenNthCalledWith(1, "transaction-1");
    expect(fixture.native.finishTransaction).toHaveBeenNthCalledWith(2, "transaction-2");
  });

  it("verifies transaction updates and stops observing on cleanup", async () => {
    const fixture = createFixture();

    fixture.service.startTransactionUpdates();
    fixture.emitTransactionUpdate(purchaseTransaction);

    await vi.waitFor(() => {
      expect(fixture.native.finishTransaction).toHaveBeenCalledWith("transaction-1");
    });
    expect(fixture.queryClient.getQueryState(fixture.billingStatusQueryKey)?.isInvalidated).toBe(
      true,
    );

    fixture.service.stopTransactionUpdates();
    expect(fixture.native.stopTransactionUpdates).toHaveBeenCalledWith(fixture.updateSubscription);
  });

  it("reports a rejected transaction update without finishing it", async () => {
    const fixture = createFixture();
    const rejection = new Error("Transaction environment is invalid.");
    vi.mocked(fixture.trpcClient.billing.verifyAppStoreTransaction.mutate).mockRejectedValueOnce(
      rejection,
    );

    fixture.service.startTransactionUpdates();
    fixture.emitTransactionUpdate(purchaseTransaction);

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(rejection, {
        source: "app-store-billing-transaction-update",
      });
    });
    expect(fixture.native.finishTransaction).not.toHaveBeenCalled();
  });

  it("observes transactions only while authenticated", () => {
    const fixture = createFixture();
    const { rerender } = renderHook(
      ({ authenticated }) => useAppStoreBillingTransactionUpdates(fixture.service, authenticated),
      { initialProps: { authenticated: false } },
    );

    expect(fixture.native.startTransactionUpdates).not.toHaveBeenCalled();

    rerender({ authenticated: true });
    expect(fixture.native.startTransactionUpdates).toHaveBeenCalledTimes(1);

    rerender({ authenticated: false });
    expect(fixture.native.stopTransactionUpdates).toHaveBeenCalledWith(fixture.updateSubscription);
  });

  it("preserves management errors after reporting them", async () => {
    const fixture = createFixture();
    const error = new Error("Apple subscription management is unavailable.");
    vi.mocked(fixture.native.showManageSubscriptions).mockRejectedValueOnce(error);

    await expect(fixture.service.showManageSubscriptions()).rejects.toBe(error);

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "app-store-billing-manage-subscriptions",
    });
  });
});
