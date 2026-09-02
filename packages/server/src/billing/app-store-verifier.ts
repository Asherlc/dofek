import {
  Environment,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  NotificationTypeV2,
  type ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  Status,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getAppStoreBillingConfig } from "./app-store-config.ts";
import {
  APP_STORE_SUBSCRIPTION_PRODUCT_ID,
  type AppStoreNotificationUpdate,
  type AppStoreSubscriptionUpdate,
} from "./app-store-subscription.ts";

type DecodedTransaction = JWSTransactionDecodedPayload;

const appStoreEnvironments = [Environment.SANDBOX, Environment.PRODUCTION] as const;

function precondition(message: string): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function rootCertificatesFromPem(rootCertificatesPem: string): Buffer[] {
  const certificates = rootCertificatesPem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!certificates || certificates.length === 0) {
    throw new Error("APP_STORE_ROOT_CERTIFICATES_PEM must contain at least one PEM certificate");
  }
  return certificates.map((certificate) => Buffer.from(certificate));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw precondition(`Verified App Store transaction is missing ${field}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw precondition(`Verified App Store notification has an invalid ${field}`);
  }
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw precondition(`Verified App Store notification has an invalid ${field}`);
  }
  return result.data;
}

function dateFromTimestamp(value: unknown, field: string, required: true): Date;
function dateFromTimestamp(value: unknown, field: string, required: false): Date | null;
function dateFromTimestamp(value: unknown, field: string, required: boolean): Date | null {
  if (value === undefined || value === null) {
    if (required) throw precondition(`Verified App Store transaction is missing ${field}`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw precondition(`Verified App Store transaction has an invalid ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw precondition(`Verified App Store transaction has an invalid ${field}`);
  }
  return date;
}

function isSupportedEnvironment(value: string): value is AppStoreSubscriptionUpdate["environment"] {
  return value === Environment.SANDBOX || value === Environment.PRODUCTION;
}

async function verifySignedTransaction(jws: string): Promise<DecodedTransaction> {
  const config = getAppStoreBillingConfig();
  const rootCertificates = rootCertificatesFromPem(config.rootCertificatesPem);

  for (const environment of appStoreEnvironments) {
    const verifier = new SignedDataVerifier(
      rootCertificates,
      true,
      environment,
      config.bundleId,
      config.appId,
    );
    try {
      return await verifier.verifyAndDecodeTransaction(jws);
    } catch {
      // SignedDataVerifier validates the claimed environment. Try the other
      // Apple environment without decoding an unverified JWS ourselves.
    }
  }

  throw precondition("App Store transaction could not be verified");
}

function normalizeVerifiedTransaction(
  transaction: DecodedTransaction,
  expectedAccountToken: string,
): AppStoreSubscriptionUpdate {
  if (expectedAccountToken.trim().length === 0) {
    throw precondition("Expected App Store account token is required");
  }

  const accountToken = requiredString(transaction.appAccountToken, "appAccountToken");
  if (accountToken !== expectedAccountToken) {
    throw precondition("App Store transaction belongs to a different account");
  }

  const productId = requiredString(transaction.productId, "productId");
  if (productId !== APP_STORE_SUBSCRIPTION_PRODUCT_ID) {
    throw precondition("App Store transaction is not for the configured subscription");
  }

  const environment = requiredString(transaction.environment, "environment");
  if (!isSupportedEnvironment(environment)) {
    throw precondition("App Store transaction has an unsupported environment");
  }

  const expiresAt = dateFromTimestamp(transaction.expiresDate, "expiresDate", true);
  const revokedAt = dateFromTimestamp(transaction.revocationDate, "revocationDate", false);

  return {
    accountToken,
    originalTransactionId: requiredString(
      transaction.originalTransactionId,
      "originalTransactionId",
    ),
    transactionId: requiredString(transaction.transactionId, "transactionId"),
    productId: APP_STORE_SUBSCRIPTION_PRODUCT_ID,
    status: revokedAt ? "revoked" : expiresAt > new Date() ? "active" : "expired",
    expiresAt,
    revokedAt,
    environment,
  };
}

function notificationStatus(value: unknown): AppStoreSubscriptionUpdate["status"] {
  switch (value) {
    case Status.ACTIVE:
      return "active";
    case Status.BILLING_GRACE_PERIOD:
      return "grace_period";
    case Status.EXPIRED:
    case Status.BILLING_RETRY:
      return "expired";
    case Status.REVOKED:
      return "revoked";
    default:
      throw precondition("Verified App Store notification has an invalid subscription status");
  }
}

function requireMatchingRenewalState(
  renewal: JWSRenewalInfoDecodedPayload,
  subscription: AppStoreSubscriptionUpdate,
): void {
  if (
    requiredString(renewal.appAccountToken, "renewal appAccountToken") !== subscription.accountToken
  ) {
    throw precondition("Verified App Store renewal belongs to a different account");
  }
  if (
    requiredString(renewal.originalTransactionId, "renewal originalTransactionId") !==
    subscription.originalTransactionId
  ) {
    throw precondition("Verified App Store renewal belongs to a different subscription");
  }
  if (requiredString(renewal.productId, "renewal productId") !== subscription.productId) {
    throw precondition("Verified App Store renewal is for a different product");
  }
  if (requiredString(renewal.environment, "renewal environment") !== subscription.environment) {
    throw precondition("Verified App Store renewal has a different environment");
  }
}

async function normalizeVerifiedNotification(
  verifier: SignedDataVerifier,
  notification: ResponseBodyV2DecodedPayload,
): Promise<AppStoreNotificationUpdate> {
  const notificationUuid = requiredUuid(notification.notificationUUID, "notificationUUID");
  const signedDate = requiredNumber(notification.signedDate, "signedDate");
  if (notification.notificationType === NotificationTypeV2.TEST) {
    return { notificationUuid, signedDate, subscription: null };
  }
  const signedTransactionInfo = requiredString(
    notification.data?.signedTransactionInfo,
    "signedTransactionInfo",
  );
  const signedRenewalInfo = requiredString(
    notification.data?.signedRenewalInfo,
    "signedRenewalInfo",
  );
  const [transaction, renewal] = await Promise.all([
    verifier.verifyAndDecodeTransaction(signedTransactionInfo),
    verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo),
  ]);
  const expectedAccountToken = requiredString(renewal.appAccountToken, "renewal appAccountToken");
  const subscription = normalizeVerifiedTransaction(transaction, expectedAccountToken);
  requireMatchingRenewalState(renewal, subscription);

  const status = subscription.revokedAt ? "revoked" : notificationStatus(notification.data?.status);
  const expiresAt =
    status === "grace_period"
      ? dateFromTimestamp(renewal.gracePeriodExpiresDate, "gracePeriodExpiresDate", true)
      : subscription.expiresAt;

  return {
    notificationUuid,
    signedDate,
    subscription: { ...subscription, status, expiresAt },
  };
}

export async function verifyAppStoreTransaction(
  jws: string,
  expectedAccountToken: string,
): Promise<AppStoreSubscriptionUpdate> {
  const transaction = await verifySignedTransaction(jws);
  return normalizeVerifiedTransaction(transaction, expectedAccountToken);
}

export async function verifyAppStoreNotification(
  signedPayload: string,
): Promise<AppStoreNotificationUpdate> {
  const config = getAppStoreBillingConfig();
  const rootCertificates = rootCertificatesFromPem(config.rootCertificatesPem);

  for (const environment of appStoreEnvironments) {
    const verifier = new SignedDataVerifier(
      rootCertificates,
      true,
      environment,
      config.bundleId,
      config.appId,
    );
    try {
      const notification = await verifier.verifyAndDecodeNotification(signedPayload);
      return await normalizeVerifiedNotification(verifier, notification);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      if (!(error instanceof VerificationException)) throw error;
      if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) throw error;
    }
  }

  throw precondition("App Store notification could not be verified");
}
