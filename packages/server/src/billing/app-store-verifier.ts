import {
  Environment,
  type JWSTransactionDecodedPayload,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { TRPCError } from "@trpc/server";
import { getAppStoreBillingConfig } from "./app-store-config.ts";
import {
  APP_STORE_SUBSCRIPTION_PRODUCT_ID,
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

export async function verifyAppStoreTransaction(
  jws: string,
  expectedAccountToken: string,
): Promise<AppStoreSubscriptionUpdate> {
  const transaction = await verifySignedTransaction(jws);
  return normalizeVerifiedTransaction(transaction, expectedAccountToken);
}
