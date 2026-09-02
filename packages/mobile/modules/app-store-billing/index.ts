import type { EventSubscription } from "expo-modules-core";
import { NativeModule, requireNativeModule } from "expo-modules-core";
import { z } from "zod";

export const APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID = "com.dofek.premium.monthly";

export interface AppStoreProduct {
  productID: string;
  displayName: string;
  description: string;
  displayPrice: string;
}

export interface AppStoreTransaction {
  transactionID: string;
  productID: string;
  signedTransaction: string;
}

export type AppStorePurchaseResult =
  | ({ outcome: "verified" } & AppStoreTransaction)
  | { outcome: "cancelled" }
  | { outcome: "pending" };

const appStoreProductSchema = z.object({
  productID: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  displayPrice: z.string().min(1),
});
const appStoreTransactionSchema = z.object({
  transactionID: z.string().min(1),
  productID: z.string().min(1),
  signedTransaction: z.string().min(1),
});
const appStorePurchaseResultSchema = z.discriminatedUnion("outcome", [
  appStoreTransactionSchema.extend({ outcome: z.literal("verified") }),
  z.object({ outcome: z.literal("cancelled") }),
  z.object({ outcome: z.literal("pending") }),
]);

type AppStoreBillingEvents = {
  onTransactionUpdate: (transaction: AppStoreTransaction) => void;
};

declare class AppStoreBillingNativeModule extends NativeModule<AppStoreBillingEvents> {
  loadProduct(productID: string): Promise<AppStoreProduct | null>;
  purchase(productID: string, appAccountToken: string): Promise<AppStorePurchaseResult>;
  restoreCurrentEntitlements(productID: string): Promise<AppStoreTransaction[]>;
  startTransactionUpdates(productID: string): void;
  stopTransactionUpdates(): void;
  finishTransaction(transactionID: string): Promise<void>;
  showManageSubscriptions(): Promise<void>;
}

const AppStoreBillingModule = requireNativeModule<AppStoreBillingNativeModule>("AppStoreBilling");

export async function loadProduct(
  productID: string = APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID,
): Promise<AppStoreProduct | null> {
  return appStoreProductSchema.nullable().parse(await AppStoreBillingModule.loadProduct(productID));
}

export async function purchase(
  productID: string,
  appAccountToken: string,
): Promise<AppStorePurchaseResult> {
  return appStorePurchaseResultSchema.parse(
    await AppStoreBillingModule.purchase(productID, appAccountToken),
  );
}

export async function restoreCurrentEntitlements(
  productID: string = APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID,
): Promise<AppStoreTransaction[]> {
  return z
    .array(appStoreTransactionSchema)
    .parse(await AppStoreBillingModule.restoreCurrentEntitlements(productID));
}

export function startTransactionUpdates(
  onTransaction: (transaction: AppStoreTransaction) => void,
  productID: string = APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID,
): EventSubscription {
  const subscription = AppStoreBillingModule.addListener("onTransactionUpdate", (transaction) => {
    onTransaction(appStoreTransactionSchema.parse(transaction));
  });
  try {
    AppStoreBillingModule.startTransactionUpdates(productID);
  } catch (error) {
    subscription.remove();
    throw error;
  }
  return subscription;
}

export function stopTransactionUpdates(subscription?: EventSubscription): void {
  AppStoreBillingModule.stopTransactionUpdates();
  subscription?.remove();
}

export async function finishTransaction(transactionID: string): Promise<void> {
  return AppStoreBillingModule.finishTransaction(transactionID);
}

export async function showManageSubscriptions(): Promise<void> {
  return AppStoreBillingModule.showManageSubscriptions();
}
