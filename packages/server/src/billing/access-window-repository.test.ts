import { describe, expect, it, vi } from "vitest";
import { getAccessWindowForUser } from "./access-window-repository.ts";

describe("getAccessWindowForUser", () => {
  it("derives limited access from user profile and billing state", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-07-21T01:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
          app_store_product_id: null,
          app_store_subscription_status: null,
          app_store_expires_at: null,
          app_store_revocation_at: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1", "America/Los_Angeles")).resolves.toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-20",
      endDateExclusive: "2026-07-27",
    });
  });

  it("grants full access for a current App Store billing-grace subscription", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-07-21T01:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
          app_store_product_id: "com.dofek.premium.monthly",
          app_store_subscription_status: "grace_period",
          app_store_expires_at: "2099-10-01T00:00:00.000Z",
          app_store_revocation_at: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1", "UTC")).resolves.toEqual({
      kind: "full",
      paid: true,
      reason: "app_store_subscription",
    });
  });

  it("does not grant App Store access for a different product", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-07-21T01:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
          app_store_product_id: "com.dofek.other.monthly",
          app_store_subscription_status: "active",
          app_store_expires_at: "2099-10-01T00:00:00.000Z",
          app_store_revocation_at: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1", "UTC")).resolves.toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-21",
      endDateExclusive: "2026-07-28",
    });
  });

  it("does not grant App Store access after an active subscription expires", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-07-21T01:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
          app_store_product_id: "com.dofek.premium.monthly",
          app_store_subscription_status: "active",
          app_store_expires_at: "2020-10-01T00:00:00.000Z",
          app_store_revocation_at: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1", "UTC")).resolves.toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-21",
      endDateExclusive: "2026-07-28",
    });
  });

  it("throws when the authenticated user profile is missing", async () => {
    const db = { execute: vi.fn(async () => []) };

    await expect(getAccessWindowForUser(db, "missing-user", "UTC")).rejects.toThrow(
      "Authenticated user profile not found",
    );
  });
});
