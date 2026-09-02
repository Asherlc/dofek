import { describe, expect, it } from "vitest";
import { resolveAccessWindow } from "./entitlement.ts";

describe("resolveAccessWindow", () => {
  it("grants full access for existing-account paid grants", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "UTC",
      paidGrantReason: "existing_account",
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "paid_grant" });
  });

  it("grants full access for active Stripe subscriptions", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "UTC",
      paidGrantReason: null,
      stripeSubscriptionStatus: "active",
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "stripe_subscription" });
  });

  it("grants full access for an active verified App Store subscription", () => {
    expect(
      resolveAccessWindow({
        userCreatedAt: "2026-09-01T00:00:00.000Z",
        timezone: "UTC",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
        appStoreSubscription: {
          productId: "com.dofek.premium.monthly",
          status: "active",
          expiresAt: "2026-10-01T00:00:00.000Z",
          revokedAt: null,
        },
        now: new Date("2026-09-15T00:00:00.000Z"),
      }),
    ).toEqual({ kind: "full", paid: true, reason: "app_store_subscription" });
  });

  it("does not grant App Store access after expiry or revocation", () => {
    expect(
      resolveAccessWindow({
        userCreatedAt: "2026-09-01T00:00:00.000Z",
        timezone: "UTC",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
        appStoreSubscription: {
          productId: "com.dofek.premium.monthly",
          status: "expired",
          expiresAt: "2026-09-10T00:00:00.000Z",
          revokedAt: null,
        },
        now: new Date("2026-09-15T00:00:00.000Z"),
      }).kind,
    ).toBe("limited");
    expect(
      resolveAccessWindow({
        userCreatedAt: "2026-09-01T00:00:00.000Z",
        timezone: "UTC",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
        appStoreSubscription: {
          productId: "com.dofek.premium.monthly",
          status: "active",
          expiresAt: "2026-10-01T00:00:00.000Z",
          revokedAt: "2026-09-14T00:00:00.000Z",
        },
        now: new Date("2026-09-15T00:00:00.000Z"),
      }).kind,
    ).toBe("limited");
  });

  it("limits unpaid users to signup day through signup day plus six", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "UTC",
      paidGrantReason: null,
      stripeSubscriptionStatus: "canceled",
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    });
  });

  it("starts the signup week on the local date west of UTC", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-07-21T01:30:00.000Z",
      timezone: "America/Los_Angeles",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-20",
      endDateExclusive: "2026-07-27",
    });
  });

  it("starts the signup week on the local date east of UTC", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-07-20T15:30:00.000Z",
      timezone: "Asia/Tokyo",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-21",
      endDateExclusive: "2026-07-28",
    });
  });

  it("advances seven local dates across daylight-saving transitions", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-03-08T07:30:00.000Z",
      timezone: "America/Los_Angeles",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-03-07",
      endDateExclusive: "2026-03-14",
    });
  });

  it("rejects invalid timezones for limited access", () => {
    expect(() =>
      resolveAccessWindow({
        userCreatedAt: "2026-04-10T18:30:00.000Z",
        timezone: "Not/A_Timezone",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
      }),
    ).toThrow(RangeError);
  });

  it("rejects invalid signup timestamps for limited access", () => {
    expect(() =>
      resolveAccessWindow({
        userCreatedAt: "not-a-timestamp",
        timezone: "UTC",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
      }),
    ).toThrow("Invalid user creation timestamp: not-a-timestamp");
  });
});
