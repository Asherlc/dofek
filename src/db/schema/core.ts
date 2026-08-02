import { pgSchema } from "drizzle-orm/pg-core";
import { getTokenUserId } from "../token-user-context.ts";

// All tables live in the 'fitness' schema
export const fitness = pgSchema("fitness");

// Stable user ID used in integration tests and fixtures.
export const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

export function resolveImplicitUserId(): string {
  const userId = getTokenUserId();
  if (!userId) {
    throw new Error("Missing user context for implicit user_id default");
  }
  return userId;
}
