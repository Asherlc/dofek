import { afterEach, describe, expect, it, vi } from "vitest";

const expectedAccountToken = "a0000000-0000-4000-8000-000000000001";
const originalEnv = { ...process.env };

const verifierMock = vi.hoisted(() => {
  const verifyAndDecodeTransaction = vi.fn();
  const SignedDataVerifier = vi.fn(function SignedDataVerifier() {
    return { verifyAndDecodeTransaction };
  });
  return { SignedDataVerifier, verifyAndDecodeTransaction };
});

vi.mock("@apple/app-store-server-library", () => ({
  Environment: {
    PRODUCTION: "Production",
    SANDBOX: "Sandbox",
  },
  SignedDataVerifier: verifierMock.SignedDataVerifier,
}));

import { getAppStoreBillingConfig } from "./app-store-config.ts";
import { verifyAppStoreTransaction } from "./app-store-verifier.ts";

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
  afterEach(() => {
    process.env = { ...originalEnv };
    verifierMock.SignedDataVerifier.mockClear();
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
});
