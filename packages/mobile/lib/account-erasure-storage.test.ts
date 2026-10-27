import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMobileAccountErasurePreparation,
  loadMobileAccountErasurePreparation,
  loadMobileAccountErasureStatusCapability,
  markMobileAccountErasureConfirmationAttempted,
  saveMobileAccountErasurePreparation,
  saveMobileAccountErasureStatusCapability,
} from "./account-erasure-storage";

describe("mobile account-erasure capability storage", () => {
  beforeEach(async () => {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync("dofek_account_erasure_preparation_v1");
    await SecureStore.deleteItemAsync("dofek_account_erasure_status_v1");
  });

  it("persists a preparation across a process restart boundary", async () => {
    await saveMobileAccountErasurePreparation({
      expiresAt: "2026-07-26T12:15:00.000Z",
      ownerUserId: "user-1",
      preparationToken: "p".repeat(43),
    });

    expect((await loadMobileAccountErasurePreparation("user-1"))?.preparationToken).toBe(
      "p".repeat(43),
    );
    expect(await loadMobileAccountErasurePreparation("user-2")).toBeNull();
  });

  it("marks an irreversible attempt before the network request", async () => {
    await saveMobileAccountErasurePreparation({
      expiresAt: "2026-07-26T12:15:00.000Z",
      ownerUserId: "user-1",
      preparationToken: "p".repeat(43),
    });

    await markMobileAccountErasureConfirmationAttempted(
      "22222222-2222-4222-8222-222222222222",
      "2026-07-26T12:05:00.000Z",
    );

    const SecureStore = await import("expo-secure-store");
    const persisted = await SecureStore.getItemAsync("dofek_account_erasure_preparation_v1");
    expect(persisted).toContain("confirmationAttemptedAt");
    expect(persisted).toContain("22222222-2222-4222-8222-222222222222");
    expect(persisted).not.toContain("user-1");
    expect(await loadMobileAccountErasurePreparation("user-1")).toBeNull();
  });

  it("preserves the public status capability after preparation is cleared", async () => {
    await saveMobileAccountErasureStatusCapability({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    await clearMobileAccountErasurePreparation();

    expect(await loadMobileAccountErasureStatusCapability()).toEqual({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
  });
});
