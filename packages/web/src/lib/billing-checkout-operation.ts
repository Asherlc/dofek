import { z } from "zod";

export const WEB_BILLING_CHECKOUT_OPERATION_KEY = "dofek:billing:checkout-operation:v1";

const BillingCheckoutOperationIdSchema = z.uuid();

export function getOrCreateWebBillingCheckoutOperationId(): string {
  const stored = window.localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY);
  if (stored !== null) {
    const parsed = BillingCheckoutOperationIdSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    window.localStorage.removeItem(WEB_BILLING_CHECKOUT_OPERATION_KEY);
  }

  const operationId = BillingCheckoutOperationIdSchema.parse(window.crypto.randomUUID());
  window.localStorage.setItem(WEB_BILLING_CHECKOUT_OPERATION_KEY, operationId);
  return operationId;
}

export function clearWebBillingCheckoutOperation(operationId: string): void {
  if (window.localStorage.getItem(WEB_BILLING_CHECKOUT_OPERATION_KEY) === operationId) {
    window.localStorage.removeItem(WEB_BILLING_CHECKOUT_OPERATION_KEY);
  }
}
