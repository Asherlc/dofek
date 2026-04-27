import { describe, expect, it } from "vitest";
import { resolveAccessWindow } from "./entitlement.ts";

describe("resolveAccessWindow", () => {
  it("grants full access for existing-account paid grants", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      paidGrantReason: "existing_account",
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "paid_grant" });
  });

  it("grants full access for active Stripe subscriptions", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      paidGrantReason: null,
      stripeSubscriptionStatus: "active",
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "stripe_subscription" });
  });

  it("limits unpaid users to signup day through signup day plus six", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
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
});
