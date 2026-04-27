import { type SQL, sql } from "drizzle-orm";

const ACCESS_GRANTING_STRIPE_STATUSES = new Set(["active", "trialing"]);

export type AccessWindow =
  | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" }
  | {
      kind: "limited";
      paid: false;
      reason: "free_signup_week";
      startDate: string;
      endDateExclusive: string;
    };

export interface ResolveAccessWindowInput {
  userCreatedAt: string;
  paidGrantReason: string | null;
  stripeSubscriptionStatus: string | null;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Returns a SQL predicate fragment that restricts a date column to the
 * billing access window. Returns an empty fragment for full-access or absent windows.
 * Intended for use in routers that build SQL inline rather than via BaseRepository.
 */
export function dateAccessPredicate(window: AccessWindow | undefined, column: SQL): SQL {
  if (!window || window.kind === "full") return sql``;
  return sql`AND ${column} >= ${window.startDate}::date
             AND ${column} < ${window.endDateExclusive}::date`;
}

/**
 * Returns a SQL predicate fragment that restricts a timestamp column to the
 * billing access window. Returns an empty fragment for full-access or absent windows.
 */
export function timestampAccessPredicate(window: AccessWindow | undefined, column: SQL): SQL {
  if (!window || window.kind === "full") return sql``;
  return sql`AND ${column} >= ${window.startDate}::date
             AND ${column} < ${window.endDateExclusive}::date`;
}

export function resolveAccessWindow(input: ResolveAccessWindowInput): AccessWindow {
  if (input.paidGrantReason) {
    return { kind: "full", paid: true, reason: "paid_grant" };
  }

  if (
    input.stripeSubscriptionStatus &&
    ACCESS_GRANTING_STRIPE_STATUSES.has(input.stripeSubscriptionStatus)
  ) {
    return { kind: "full", paid: true, reason: "stripe_subscription" };
  }

  const start = new Date(input.userCreatedAt);
  const startUtcMidnight = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endExclusive = new Date(startUtcMidnight);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 7);

  return {
    kind: "limited",
    paid: false,
    reason: "free_signup_week",
    startDate: toDateOnly(startUtcMidnight),
    endDateExclusive: toDateOnly(endExclusive),
  };
}
