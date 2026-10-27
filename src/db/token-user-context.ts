import { AsyncLocalStorage } from "node:async_hooks";
import { runWithProviderTokenDiagnostics } from "../lib/provider-token-diagnostic-context.ts";

const tokenUserContext = new AsyncLocalStorage<string>();

export function runWithTokenUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  return tokenUserContext.run(userId, () => runWithProviderTokenDiagnostics(userId, callback));
}

export function getTokenUserId(): string | undefined {
  const scopedUserId = tokenUserContext.getStore();
  if (scopedUserId) {
    return scopedUserId;
  }
  // Test runners can provide a default scoped user via env when no async context is active.
  if (process.env.TEST_TOKEN_USER_ID) {
    return process.env.TEST_TOKEN_USER_ID;
  }
  return undefined;
}
