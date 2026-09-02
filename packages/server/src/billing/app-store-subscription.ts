export const APP_STORE_SUBSCRIPTION_PRODUCT_ID = "com.dofek.premium.monthly";

export interface AppStoreSubscriptionUpdate {
  accountToken: string;
  originalTransactionId: string;
  transactionId: string;
  productId: typeof APP_STORE_SUBSCRIPTION_PRODUCT_ID;
  status: "active" | "grace_period" | "expired" | "revoked";
  expiresAt: Date | null;
  revokedAt: Date | null;
  environment: "Sandbox" | "Production";
}
