import * as Crypto from "expo-crypto";
import { z } from "zod";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";

export const MOBILE_BILLING_CHECKOUT_OPERATION_KEY = "dofek_billing_checkout_operation_v1";

const BillingCheckoutOperationIdSchema = z.uuid();

export async function getOrCreateMobileBillingCheckoutOperationId(): Promise<string> {
  const stored = await readSecureStoreItem(MOBILE_BILLING_CHECKOUT_OPERATION_KEY);
  if (stored !== null) {
    const parsed = BillingCheckoutOperationIdSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error("Stored billing checkout operation ID is invalid.");
    }
    return parsed.data;
  }

  const operationId = BillingCheckoutOperationIdSchema.parse(Crypto.randomUUID());
  await writeSecureStoreItem(MOBILE_BILLING_CHECKOUT_OPERATION_KEY, operationId);
  return operationId;
}

export async function clearMobileBillingCheckoutOperation(operationId: string): Promise<void> {
  const stored = await readSecureStoreItem(MOBILE_BILLING_CHECKOUT_OPERATION_KEY);
  if (stored === operationId) {
    await deleteSecureStoreItem(MOBILE_BILLING_CHECKOUT_OPERATION_KEY);
  }
}

export async function clearPendingMobileBillingCheckoutOperation(): Promise<void> {
  await deleteSecureStoreItem(MOBILE_BILLING_CHECKOUT_OPERATION_KEY);
}
