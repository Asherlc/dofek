// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWebBillingCheckoutOperation,
  getOrCreateWebBillingCheckoutOperationId,
  WEB_BILLING_CHECKOUT_OPERATION_KEY,
} from "./billing-checkout-operation.ts";

const checkoutOperationId = "20000000-0000-4000-8000-000000000001";
const nextCheckoutOperationId = "20000000-0000-4000-8000-000000000002";

describe("web billing checkout operation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("persists a new UUID before returning it", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(checkoutOperationId);

    expect(getOrCreateWebBillingCheckoutOperationId()).toBe(checkoutOperationId);
    expect(localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY)).toBe(checkoutOperationId);
  });

  it("reuses the persisted UUID after a response-loss retry", () => {
    localStorage.setItem(WEB_BILLING_CHECKOUT_OPERATION_KEY, checkoutOperationId);
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(nextCheckoutOperationId);

    expect(getOrCreateWebBillingCheckoutOperationId()).toBe(checkoutOperationId);
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it("replaces a malformed persisted UUID", () => {
    localStorage.setItem(WEB_BILLING_CHECKOUT_OPERATION_KEY, "not-a-uuid");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(checkoutOperationId);

    expect(getOrCreateWebBillingCheckoutOperationId()).toBe(checkoutOperationId);
    expect(localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY)).toBe(checkoutOperationId);
  });

  it("clears only the operation that received a successful response", () => {
    localStorage.setItem(WEB_BILLING_CHECKOUT_OPERATION_KEY, nextCheckoutOperationId);

    clearWebBillingCheckoutOperation(checkoutOperationId);
    expect(localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY)).toBe(nextCheckoutOperationId);

    clearWebBillingCheckoutOperation(nextCheckoutOperationId);
    expect(localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY)).toBeNull();
  });
});
