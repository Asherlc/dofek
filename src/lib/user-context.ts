import { getTokenUserId } from "../db/token-user-context.ts";

export function resolveScopedUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("A user ID is required for this operation");
  }
  return scopedUserId;
}
