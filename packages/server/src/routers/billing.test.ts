import { describe, expect, it, vi } from "vitest";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: { execute: unknown }; userId: string; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(async () => [
      {
        id: "user-1",
        created_at: "2026-04-10T18:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: null,
      },
    ]),
  };
});

import { billingRouter } from "./billing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(billingRouter);

describe("billingRouter", () => {
  it("returns limited signup-week status for unpaid users", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.status()).resolves.toEqual({
      hasFullAccess: false,
      access: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
      stripeSubscriptionStatus: null,
      canManageBilling: false,
    });
  });
});
