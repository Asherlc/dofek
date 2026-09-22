import { describe, expect, it } from "vitest";
import { resolveAccessWindow, toAppStoreSubscriptionState } from "./entitlement.ts";

describe("resolveAccessWindow", () => {
  it.each([
    {
      input: {
        productId: "com.dofek.premium.monthly",
        status: "active",
        expiresAt: "2099-10-01T00:00:00.000Z",
        revokedAt: null,
      },
      expected: {
        productId: "com.dofek.premium.monthly",
        status: "active",
        expiresAt: "2099-10-01T00:00:00.000Z",
        revokedAt: null,
      },
    },
    {
      input: {
        productId: null,
        status: "active",
        expiresAt: "2099-10-01T00:00:00.000Z",
        revokedAt: null,
      },
      expected: undefined,
    },
    {
      input: {
        productId: "com.dofek.premium.monthly",
        status: null,
        expiresAt: "2099-10-01T00:00:00.000Z",
        revokedAt: null,
      },
      expected: undefined,
    },
    {
      input: {
        productId: "com.dofek.premium.monthly",
        status: "active",
        expiresAt: null,
        revokedAt: null,
      },
      expected: undefined,
    },
  ])("maps App Store billing row %#", ({ input, expected }) => {
    expect(toAppStoreSubscriptionState(input)).toEqual(expected);
  });

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
          status: "active",
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
          expiresAt: "2026-09-15T00:00:00.000Z",
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

  it("limits unpaid users to the most recent 7 calendar days including today", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "UTC",
      paidGrantReason: null,
      stripeSubscriptionStatus: "canceled",
      now: new Date("2026-09-22T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-09-16",
      endDateExclusive: "2026-09-23",
    });
  });

  it("ignores account age when computing the recent window", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-09-20T18:30:00.000Z",
      timezone: "UTC",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
      now: new Date("2026-09-22T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-09-16",
      endDateExclusive: "2026-09-23",
    });
  });

  it("ends the recent week on the local date west of UTC", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "America/Los_Angeles",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
      now: new Date("2026-07-21T01:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-07-14",
      endDateExclusive: "2026-07-21",
    });
  });

  it("ends the recent week on the local date east of UTC", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "Asia/Tokyo",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
      now: new Date("2026-07-20T15:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-07-15",
      endDateExclusive: "2026-07-22",
    });
  });

  it("spans seven local dates across daylight-saving transitions", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      timezone: "America/Los_Angeles",
      paidGrantReason: null,
      stripeSubscriptionStatus: null,
      now: new Date("2026-03-08T07:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-03-01",
      endDateExclusive: "2026-03-08",
    });
  });

  it("rejects an invalid current timestamp for limited access", () => {
    expect(() =>
      resolveAccessWindow({
        userCreatedAt: "2026-04-10T18:30:00.000Z",
        timezone: "UTC",
        paidGrantReason: null,
        stripeSubscriptionStatus: null,
        now: new Date(Number.NaN),
      }),
    ).toThrow(RangeError);
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
});
