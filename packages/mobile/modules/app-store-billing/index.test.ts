import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  finishTransaction: vi.fn(),
  loadProduct: vi.fn(),
  purchase: vi.fn(),
  restoreCurrentEntitlements: vi.fn(),
  showManageSubscriptions: vi.fn(),
  startTransactionUpdates: vi.fn(),
  stopTransactionUpdates: vi.fn(),
}));

vi.mock("expo-modules-core", () => ({
  NativeModule: class {},
  requireNativeModule: () => nativeModule,
}));

const captureException = vi.hoisted(() => vi.fn());

vi.mock("../../lib/telemetry", () => ({ captureException }));

vi.unmock("./index");

import {
  loadProduct,
  purchase,
  restoreCurrentEntitlements,
  startTransactionUpdates,
} from "./index.ts";

describe("App Store billing native boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed product and purchase responses from the native module", async () => {
    nativeModule.loadProduct.mockResolvedValue({ productID: "com.dofek.premium.monthly" });
    nativeModule.purchase.mockResolvedValue({
      outcome: "verified",
      transactionID: "transaction-1",
    });

    await expect(loadProduct()).rejects.toThrow();
    await expect(purchase("com.dofek.premium.monthly", "account-token")).rejects.toThrow();
  });

  it("rejects malformed restored transactions and transaction updates", async () => {
    nativeModule.restoreCurrentEntitlements.mockResolvedValue([{ transactionID: "transaction-1" }]);
    const subscription = { remove: vi.fn() };
    let listener: ((transaction: unknown) => void) | undefined;
    nativeModule.addListener.mockImplementation(
      (_event: string, callback: (transaction: unknown) => void) => {
        listener = callback;
        return subscription;
      },
    );

    await expect(restoreCurrentEntitlements()).rejects.toThrow();
    startTransactionUpdates(vi.fn());
    expect(() => listener?.({ transactionID: "transaction-1" })).toThrow();
  });

  it("reports a native transaction-update startup failure", () => {
    const error = new Error("StoreKit unavailable");
    nativeModule.addListener.mockReturnValue({ remove: vi.fn() });
    nativeModule.startTransactionUpdates.mockImplementation(() => {
      throw error;
    });

    expect(() => startTransactionUpdates(vi.fn())).toThrow(error);
    expect(captureException).toHaveBeenCalledWith(error, {
      source: "app-store-billing-transaction-updates-start",
    });
  });
});
