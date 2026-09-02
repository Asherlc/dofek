import type { EventSubscription } from "expo-modules-core";
import { NativeModule, requireNativeModule } from "expo-modules-core";

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
  return AppStoreBillingModule.loadProduct(productID);
}

export async function purchase(
  productID: string,
  appAccountToken: string,
): Promise<AppStorePurchaseResult> {
  return AppStoreBillingModule.purchase(productID, appAccountToken);
}

export async function restoreCurrentEntitlements(
  productID: string = APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID,
): Promise<AppStoreTransaction[]> {
  return AppStoreBillingModule.restoreCurrentEntitlements(productID);
}

export function startTransactionUpdates(
  onTransaction: (transaction: AppStoreTransaction) => void,
  productID: string = APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID,
): EventSubscription {
  const subscription = AppStoreBillingModule.addListener("onTransactionUpdate", onTransaction);
  AppStoreBillingModule.startTransactionUpdates(productID);
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
