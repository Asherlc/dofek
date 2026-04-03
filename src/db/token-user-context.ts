import { AsyncLocalStorage } from "node:async_hooks";

const tokenUserContext = new AsyncLocalStorage<string>();

export function runWithTokenUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  return tokenUserContext.run(userId, callback);
}

export function getTokenUserId(): string | undefined {
  const scopedUserId = tokenUserContext.getStore();
  if (scopedUserId) {
    return scopedUserId;
  }
  // Test runners can provide a default scoped user via env when no async context is active.
  // This fallback is intentionally restricted to test environments to prevent accidental
  // attribution of writes to the wrong user in production.
  if ((process.env.NODE_ENV === "test" || process.env.VITEST) && process.env.TEST_TOKEN_USER_ID) {
    return process.env.TEST_TOKEN_USER_ID;
  }
  return undefined;
}
