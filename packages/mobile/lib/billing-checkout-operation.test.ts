import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMobileBillingCheckoutOperation,
  getOrCreateMobileBillingCheckoutOperationId,
  MOBILE_BILLING_CHECKOUT_OPERATION_KEY,
} from "./billing-checkout-operation";

const checkoutOperationId = "10000000-0000-4000-8000-000000000001";
const nextCheckoutOperationId = "10000000-0000-4000-8000-000000000002";
const mockRandomUUID = vi.hoisted(() => vi.fn());

vi.mock("expo-crypto", () => ({
  randomUUID: mockRandomUUID,
}));

describe("mobile billing checkout operation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRandomUUID.mockReturnValue(checkoutOperationId);
    await SecureStore.deleteItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY);
  });

  it("persists a new UUID before returning it", async () => {
    await expect(getOrCreateMobileBillingCheckoutOperationId()).resolves.toBe(checkoutOperationId);
    await expect(SecureStore.getItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY)).resolves.toBe(
      checkoutOperationId,
    );
  });

  it("reuses the persisted UUID after a response-loss retry", async () => {
    await SecureStore.setItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY, checkoutOperationId);
    mockRandomUUID.mockReturnValue(nextCheckoutOperationId);

    await expect(getOrCreateMobileBillingCheckoutOperationId()).resolves.toBe(checkoutOperationId);
    expect(mockRandomUUID).not.toHaveBeenCalled();
  });

  it("clears only the operation that received a successful response", async () => {
    await SecureStore.setItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY, nextCheckoutOperationId);

    await clearMobileBillingCheckoutOperation(checkoutOperationId);
    await expect(SecureStore.getItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY)).resolves.toBe(
      nextCheckoutOperationId,
    );

    await clearMobileBillingCheckoutOperation(nextCheckoutOperationId);
    await expect(
      SecureStore.getItemAsync(MOBILE_BILLING_CHECKOUT_OPERATION_KEY),
    ).resolves.toBeNull();
  });
});
