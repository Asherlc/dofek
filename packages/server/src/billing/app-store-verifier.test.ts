import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const expectedAccountToken = "a0000000-0000-4000-8000-000000000001";
const originalEnv = { ...process.env };

const verifierMock = vi.hoisted(() => {
  class VerificationException extends Error {
    constructor(readonly status: number) {
      super(`verification failed with status ${status}`);
    }
  }
  const verifyAndDecodeNotification = vi.fn();
  const verifyAndDecodeRenewalInfo = vi.fn();
  const verifyAndDecodeTransaction = vi.fn();
  const SignedDataVerifier = vi.fn(function SignedDataVerifier() {
    return {
      verifyAndDecodeNotification,
      verifyAndDecodeRenewalInfo,
      verifyAndDecodeTransaction,
    };
  });
  return {
    SignedDataVerifier,
    VerificationException,
    verifyAndDecodeNotification,
    verifyAndDecodeRenewalInfo,
    verifyAndDecodeTransaction,
  };
});

vi.mock("@apple/app-store-server-library", () => ({
  Environment: {
    PRODUCTION: "Production",
    SANDBOX: "Sandbox",
  },
  NotificationTypeV2: {
    TEST: "TEST",
  },
  Status: {
    ACTIVE: 1,
    EXPIRED: 2,
    BILLING_RETRY: 3,
    BILLING_GRACE_PERIOD: 4,
    REVOKED: 5,
  },
  SignedDataVerifier: verifierMock.SignedDataVerifier,
  VerificationException: verifierMock.VerificationException,
  VerificationStatus: {
    VERIFICATION_FAILURE: 1,
    RETRYABLE_VERIFICATION_FAILURE: 2,
  },
}));

import { getAppStoreBillingConfig } from "./app-store-config.ts";
import { verifyAppStoreNotification, verifyAppStoreTransaction } from "./app-store-verifier.ts";

function setAppStoreEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  process.env.APP_STORE_ISSUER_ID = "issuer-id";
  process.env.APP_STORE_KEY_ID = "key-id";
  process.env.APP_STORE_PRIVATE_KEY = "private-key";
  process.env.APP_STORE_APP_ID = "123456789";
  process.env.APP_STORE_BUNDLE_ID = "com.dofek.app";
  process.env.APP_STORE_SUBSCRIPTION_PRODUCT_ID = "com.dofek.premium.monthly";
  process.env.APP_STORE_ROOT_CERTIFICATES_PEM =
    "-----BEGIN CERTIFICATE-----\ntest-root-certificate\n-----END CERTIFICATE-----";
  Object.assign(process.env, overrides);
}

describe("App Store transaction verification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    verifierMock.SignedDataVerifier.mockClear();
    verifierMock.verifyAndDecodeNotification.mockReset();
    verifierMock.verifyAndDecodeRenewalInfo.mockReset();
    verifierMock.verifyAndDecodeTransaction.mockReset();
  });

  it("fails fast by naming a missing App Store configuration key", () => {
    setAppStoreEnv({ APP_STORE_BUNDLE_ID: "" });

    expect(() => getAppStoreBillingConfig()).toThrow(
      "APP_STORE_BUNDLE_ID environment variable is required",
    );
  });

  it("rejects a product other than the one supported by the application", () => {
    setAppStoreEnv({ APP_STORE_SUBSCRIPTION_PRODUCT_ID: "com.example.other" });

    expect(() => getAppStoreBillingConfig()).toThrow(
      "APP_STORE_SUBSCRIPTION_PRODUCT_ID must be com.dofek.premium.monthly",
    );
  });

  it("accepts a verified transaction only for the configured product and account token", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      expiresDate: 1_790_812_800_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      revocationDate: undefined,
      transactionId: "100000000000002",
    });

    const result = await verifyAppStoreTransaction("signed-jws", expectedAccountToken);

    expect(result).toEqual({
      accountToken: expectedAccountToken,
      originalTransactionId: "100000000000001",
      transactionId: "100000000000002",
      productId: "com.dofek.premium.monthly",
      status: "active",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      environment: "Sandbox",
    });
    expect(verifierMock.SignedDataVerifier).toHaveBeenCalledWith(
      [
        Buffer.from(
          "-----BEGIN CERTIFICATE-----\ntest-root-certificate\n-----END CERTIFICATE-----",
        ),
      ],
      true,
      "Sandbox",
      "com.dofek.app",
      123456789,
    );
  });

  it("rejects a verified transaction for a different app account token", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: "a0000000-0000-4000-8000-000000000002",
      environment: "Sandbox",
      expiresDate: 1_791_873_600_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
    });

    await expect(
      verifyAppStoreTransaction("other-account-jws", expectedAccountToken),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("rejects an unverified transaction", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockRejectedValue(new Error("invalid signature"));

    await expect(
      verifyAppStoreTransaction("invalid-jws", expectedAccountToken),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it.each([
    ["a product outside the configured subscription", { productId: "com.dofek.other" }],
    ["a transaction without an account token", { appAccountToken: undefined }],
    ["a transaction without an original transaction ID", { originalTransactionId: "" }],
    ["a transaction without an expiry", { expiresDate: undefined }],
    ["a transaction with a malformed expiry", { expiresDate: "tomorrow" }],
    ["a transaction with an unsupported environment", { environment: "Xcode" }],
  ])("rejects %s", async (_description, invalidValues) => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      expiresDate: 1_791_873_600_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
      ...invalidValues,
    });

    await expect(
      verifyAppStoreTransaction("invalid-data-jws", expectedAccountToken),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("normalizes an expired verified transaction", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Production",
      expiresDate: 1_725_155_200_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
    });

    await expect(
      verifyAppStoreTransaction("expired-jws", expectedAccountToken),
    ).resolves.toMatchObject({
      status: "expired",
      environment: "Production",
    });
  });

  it("normalizes a revoked verified transaction", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      expiresDate: 1_791_873_600_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      revocationDate: 1_789_776_000_000,
      transactionId: "100000000000002",
    });

    await expect(
      verifyAppStoreTransaction("revoked-jws", expectedAccountToken),
    ).resolves.toMatchObject({
      status: "revoked",
      revokedAt: new Date("2026-09-19T00:00:00.000Z"),
    });
  });

  it("verifies a subscription notification and both nested JWS payloads", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: "DID_RENEW",
      notificationUUID: "20000000-0000-4000-8000-000000000001",
      signedDate: 1_789_488_000_000,
      data: {
        status: 1,
        signedTransactionInfo: "signed-transaction-jws",
        signedRenewalInfo: "signed-renewal-jws",
      },
    });
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      expiresDate: 1_790_812_800_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
    });
    verifierMock.verifyAndDecodeRenewalInfo.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
    });

    await expect(verifyAppStoreNotification("signed-notification-jws")).resolves.toEqual({
      notificationUuid: "20000000-0000-4000-8000-000000000001",
      signedDate: 1_789_488_000_000,
      subscription: {
        accountToken: expectedAccountToken,
        originalTransactionId: "100000000000001",
        transactionId: "100000000000002",
        productId: "com.dofek.premium.monthly",
        status: "active",
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        revokedAt: null,
        environment: "Sandbox",
      },
    });
    expect(verifierMock.verifyAndDecodeNotification).toHaveBeenCalledWith(
      "signed-notification-jws",
    );
    expect(verifierMock.verifyAndDecodeTransaction).toHaveBeenCalledWith("signed-transaction-jws");
    expect(verifierMock.verifyAndDecodeRenewalInfo).toHaveBeenCalledWith("signed-renewal-jws");
  });

  it("uses the verified grace-period expiry for billing grace state", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: "DID_FAIL_TO_RENEW",
      notificationUUID: "20000000-0000-4000-8000-000000000002",
      signedDate: 1_789_488_000_000,
      data: {
        status: 4,
        signedTransactionInfo: "signed-transaction-jws",
        signedRenewalInfo: "signed-renewal-jws",
      },
    });
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Production",
      expiresDate: 1_789_401_600_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
    });
    verifierMock.verifyAndDecodeRenewalInfo.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Production",
      gracePeriodExpiresDate: 1_790_812_800_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
    });

    await expect(verifyAppStoreNotification("signed-notification-jws")).resolves.toMatchObject({
      subscription: {
        status: "grace_period",
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
  });

  it("accepts a verified Apple test notification without changing subscription state", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: "TEST",
      notificationUUID: "20000000-0000-4000-8000-000000000003",
      signedDate: 1_789_488_000_000,
      data: {
        bundleId: "com.dofek.app",
        environment: "Sandbox",
      },
    });

    await expect(verifyAppStoreNotification("signed-test-notification-jws")).resolves.toEqual({
      notificationUuid: "20000000-0000-4000-8000-000000000003",
      signedDate: 1_789_488_000_000,
      subscription: null,
    });
    expect(verifierMock.verifyAndDecodeTransaction).not.toHaveBeenCalled();
    expect(verifierMock.verifyAndDecodeRenewalInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["notification UUID", { notificationUUID: undefined }],
    ["signed date", { signedDate: undefined }],
    ["signed transaction", { data: { status: 1, signedRenewalInfo: "renewal-jws" } }],
    ["signed renewal info", { data: { status: 1, signedTransactionInfo: "transaction-jws" } }],
  ])("rejects a verified subscription notification without its %s", async (_field, override) => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: "DID_RENEW",
      notificationUUID: "20000000-0000-4000-8000-000000000001",
      signedDate: 1_789_488_000_000,
      data: {
        status: 1,
        signedTransactionInfo: "signed-transaction-jws",
        signedRenewalInfo: "signed-renewal-jws",
      },
      ...override,
    });

    await expect(verifyAppStoreNotification("incomplete-notification-jws")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("rejects an unverified notification", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockRejectedValue(
      new verifierMock.VerificationException(1),
    );

    await expect(verifyAppStoreNotification("invalid-jws")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(verifierMock.verifyAndDecodeTransaction).not.toHaveBeenCalled();
    expect(verifierMock.verifyAndDecodeRenewalInfo).not.toHaveBeenCalled();
  });

  it("does not classify an unexpected verifier failure as an invalid client payload", async () => {
    setAppStoreEnv();
    const unexpectedError = new TypeError("certificate verifier crashed");
    verifierMock.verifyAndDecodeNotification.mockRejectedValue(unexpectedError);

    await expect(verifyAppStoreNotification("unprocessed-jws")).rejects.toBe(unexpectedError);
  });

  it("propagates retryable Apple verification failures for server error handling", async () => {
    setAppStoreEnv();
    const retryableError = new verifierMock.VerificationException(2);
    verifierMock.verifyAndDecodeNotification.mockRejectedValue(retryableError);

    await expect(verifyAppStoreNotification("retryable-jws")).rejects.toBe(retryableError);
  });

  it("rejects inconsistent verified transaction and renewal account state", async () => {
    setAppStoreEnv();
    verifierMock.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: "DID_RENEW",
      notificationUUID: "20000000-0000-4000-8000-000000000001",
      signedDate: 1_789_488_000_000,
      data: {
        status: 1,
        signedTransactionInfo: "signed-transaction-jws",
        signedRenewalInfo: "signed-renewal-jws",
      },
    });
    verifierMock.verifyAndDecodeTransaction.mockResolvedValue({
      appAccountToken: expectedAccountToken,
      environment: "Sandbox",
      expiresDate: 1_790_812_800_000,
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
      transactionId: "100000000000002",
    });
    verifierMock.verifyAndDecodeRenewalInfo.mockResolvedValue({
      appAccountToken: "a0000000-0000-4000-8000-000000000002",
      environment: "Sandbox",
      originalTransactionId: "100000000000001",
      productId: "com.dofek.premium.monthly",
    });

    await expect(verifyAppStoreNotification("inconsistent-notification-jws")).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );
  });
});
