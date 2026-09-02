import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { type SQL, sql } from "drizzle-orm";
import { APP_STORE_SUBSCRIPTION_PRODUCT_ID } from "./app-store-subscription.ts";

const ACCESS_GRANTING_STRIPE_STATUSES = new Set(["active", "trialing"]);
const ACCESS_GRANTING_APP_STORE_STATUSES = new Set(["active", "grace_period"]);

export interface AppStoreSubscriptionState {
  productId: string;
  status: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AppStoreSubscriptionColumns {
  productId: string | null;
  status: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function toAppStoreSubscriptionState(
  columns: AppStoreSubscriptionColumns,
): AppStoreSubscriptionState | undefined {
  if (columns.productId === null || columns.status === null || columns.expiresAt === null) {
    return undefined;
  }
  return {
    productId: columns.productId,
    status: columns.status,
    expiresAt: columns.expiresAt,
    revokedAt: columns.revokedAt,
  };
}

export type AccessWindow =
  | {
      kind: "full";
      paid: true;
      reason: "paid_grant" | "stripe_subscription" | "app_store_subscription";
    }
  | {
      kind: "limited";
      paid: false;
      reason: "free_signup_week";
      startDate: string;
      endDateExclusive: string;
    };

export interface ResolveAccessWindowInput {
  userCreatedAt: string;
  timezone: string;
  paidGrantReason: string | null;
  stripeSubscriptionStatus: string | null;
  appStoreSubscription?: AppStoreSubscriptionState;
  now?: Date;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addCalendarDays(date: string, days: number): string {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return toDateOnly(new Date(Date.UTC(year, month - 1, day + days)));
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

  const appStoreSubscription = input.appStoreSubscription;
  if (
    appStoreSubscription?.productId === APP_STORE_SUBSCRIPTION_PRODUCT_ID &&
    ACCESS_GRANTING_APP_STORE_STATUSES.has(appStoreSubscription.status) &&
    new Date(appStoreSubscription.expiresAt) > (input.now ?? new Date()) &&
    appStoreSubscription.revokedAt === null
  ) {
    return { kind: "full", paid: true, reason: "app_store_subscription" };
  }

  const startDate = formatDateYmdInTimeZone(input.userCreatedAt, input.timezone);
  if (startDate === "--") {
    throw new RangeError(`Invalid user creation timestamp: ${input.userCreatedAt}`);
  }

  return {
    kind: "limited",
    paid: false,
    reason: "free_signup_week",
    startDate,
    endDateExclusive: addCalendarDays(startDate, 7),
  };
}
