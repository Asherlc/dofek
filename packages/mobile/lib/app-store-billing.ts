import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AppStorePurchaseResult, AppStoreTransaction } from "../modules/app-store-billing";
import * as defaultNative from "../modules/app-store-billing";
import { APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID } from "../modules/app-store-billing";
import { captureException } from "./telemetry";

interface AppStoreTransactionSubscription {
  remove(): void;
}

export interface AppStoreBillingNative {
  purchase(productID: string, appAccountToken: string): Promise<AppStorePurchaseResult>;
  restoreCurrentEntitlements(productID?: string): Promise<AppStoreTransaction[]>;
  startTransactionUpdates(
    onTransaction: (transaction: AppStoreTransaction) => void,
    productID?: string,
  ): AppStoreTransactionSubscription;
  stopTransactionUpdates(subscription?: AppStoreTransactionSubscription): void;
  finishTransaction(transactionID: string): Promise<void>;
  showManageSubscriptions(): Promise<void>;
}

export interface AppStoreBillingTrpcClient {
  billing: {
    appStorePurchaseContext: {
      query(): Promise<{ productId: string; appAccountToken: string }>;
    };
    verifyAppStoreTransaction: {
      mutate(input: { signedTransaction: string }): Promise<unknown>;
    };
  };
}

const billingStatusQueryKey = [["billing", "status"]] as const;

export class AppStoreBillingService {
  readonly #native: AppStoreBillingNative;
  readonly #queryClient: Pick<QueryClient, "invalidateQueries">;
  readonly #trpcClient: AppStoreBillingTrpcClient;
  #transactionUpdatesSubscription: AppStoreTransactionSubscription | null = null;

  constructor(input: {
    native?: AppStoreBillingNative;
    queryClient: Pick<QueryClient, "invalidateQueries">;
    trpcClient: AppStoreBillingTrpcClient;
  }) {
    this.#native = input.native ?? defaultNative;
    this.#queryClient = input.queryClient;
    this.#trpcClient = input.trpcClient;
  }

  async subscribe(): Promise<AppStorePurchaseResult> {
    try {
      const context = await this.#trpcClient.billing.appStorePurchaseContext.query();
      const result = await this.#native.purchase(context.productId, context.appAccountToken);
      if (result.outcome === "verified") {
        await this.#verifyAndFinish(result);
      }
      return result;
    } catch (error: unknown) {
      captureException(error, { source: "app-store-billing-subscribe" });
      throw error;
    }
  }

  async restore(): Promise<number> {
    try {
      const context = await this.#trpcClient.billing.appStorePurchaseContext.query();
      const transactions = await this.#native.restoreCurrentEntitlements(context.productId);
      for (const transaction of transactions) {
        await this.#verifyAndFinish(transaction);
      }
      return transactions.length;
    } catch (error: unknown) {
      captureException(error, { source: "app-store-billing-restore" });
      throw error;
    }
  }

  startTransactionUpdates(): void {
    if (this.#transactionUpdatesSubscription) return;
    try {
      this.#transactionUpdatesSubscription = this.#native.startTransactionUpdates((transaction) => {
        void this.#verifyAndFinish(transaction).catch((error: unknown) => {
          captureException(error, { source: "app-store-billing-transaction-update" });
        });
      }, APP_STORE_PREMIUM_MONTHLY_PRODUCT_ID);
    } catch (error: unknown) {
      captureException(error, { source: "app-store-billing-transaction-updates-start" });
    }
  }

  stopTransactionUpdates(): void {
    const subscription = this.#transactionUpdatesSubscription;
    if (!subscription) return;
    this.#transactionUpdatesSubscription = null;
    try {
      this.#native.stopTransactionUpdates(subscription);
    } catch (error: unknown) {
      captureException(error, { source: "app-store-billing-transaction-updates-stop" });
    }
  }

  async showManageSubscriptions(): Promise<void> {
    try {
      await this.#native.showManageSubscriptions();
    } catch (error: unknown) {
      captureException(error, { source: "app-store-billing-manage-subscriptions" });
      throw error;
    }
  }

  async #verifyAndFinish(transaction: AppStoreTransaction): Promise<void> {
    await this.#trpcClient.billing.verifyAppStoreTransaction.mutate({
      signedTransaction: transaction.signedTransaction,
    });
    await this.#native.finishTransaction(transaction.transactionID);
    await this.#queryClient.invalidateQueries({ queryKey: billingStatusQueryKey });
  }
}

export function useAppStoreBillingTransactionUpdates(
  service: AppStoreBillingService,
  isAuthenticated: boolean,
): void {
  useEffect(() => {
    if (!isAuthenticated) return;
    service.startTransactionUpdates();
    return () => service.stopTransactionUpdates();
  }, [isAuthenticated, service]);
}
