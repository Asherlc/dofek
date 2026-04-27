import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { protectedProcedure, router } from "../trpc.ts";

const BILLING_SIGNUP_DAYS = 7;
const FREE_SIGNUP_GRANT_REASON = "free_signup_week";

const userCreatedAtRowSchema = z.object({ createdAt: timestampStringSchema });
const statusAccessRowSchema = z.object({
  kind: z.enum(["limited", "full"]),
  paid: z.boolean(),
  reason: z.enum(["free_signup_week", "paid_grant", "stripe_subscription"]),
  startDate: z.string(),
  endDateExclusive: z.string(),
});
const statusResponseSchema = z.object({
  hasFullAccess: z.boolean(),
  access: statusAccessRowSchema,
  stripeSubscriptionStatus: z.string().nullable(),
  canManageBilling: z.boolean(),
});

function getDateOnly(date: Date): string {
  return date.toISOString().split("T")[0] ?? "";
}

function getSignupWeekEndExclusive(createdAt: string, days: number): string {
  const start = new Date(`${createdAt}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return getDateOnly(end);
}

export const billingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      userCreatedAtRowSchema,
      sql`SELECT created_at::text AS "createdAt" FROM fitness.user_profile WHERE id = ${ctx.userId}`,
    );
    const createdAtRow = rows[0];

    if (!createdAtRow) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to load account creation date for subscription status",
      });
    }

    const startDate = getDateOnly(new Date(createdAtRow.createdAt));
    const endDateExclusive = getSignupWeekEndExclusive(startDate, BILLING_SIGNUP_DAYS);
    const nowDate = new Date();
    const now = getDateOnly(nowDate);
    const hasFullAccess = now >= endDateExclusive;

    const status = statusResponseSchema.parse({
      hasFullAccess,
      access: hasFullAccess
        ? {
            kind: "full",
            paid: false,
            reason: "free_signup_week" as const,
            startDate,
            endDateExclusive,
          }
        : {
            kind: "limited",
            paid: false,
            reason: FREE_SIGNUP_GRANT_REASON,
            startDate,
            endDateExclusive,
          },
      stripeSubscriptionStatus: null,
      canManageBilling: false,
    });
    return status;
  }),

  createCheckoutSession: protectedProcedure.mutation(async () => {
    const checkoutUrl = process.env.STRIPE_CHECKOUT_URL;
    if (!checkoutUrl) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "STRIPE_CHECKOUT_URL is not configured",
      });
    }
    return { url: checkoutUrl };
  }),

  createPortalSession: protectedProcedure.mutation(async () => {
    const portalUrl = process.env.STRIPE_PORTAL_URL;
    if (!portalUrl) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "STRIPE_PORTAL_URL is not configured",
      });
    }
    return { url: portalUrl };
  }),
});
