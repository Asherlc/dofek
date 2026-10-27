import { AsyncLocalStorage } from "node:async_hooks";
import { runWithTokenUser } from "./token-user-context.ts";

export interface ProviderIngestContext {
  homeTimezone: string | null;
}

const providerIngestContext = new AsyncLocalStorage<ProviderIngestContext>();

export function runWithProviderIngestContext<T>(
  context: ProviderIngestContext,
  callback: () => Promise<T>,
): Promise<T> {
  return providerIngestContext.run(context, callback);
}

export function getProviderIngestContext(): ProviderIngestContext | undefined {
  return providerIngestContext.getStore();
}

export function runWithProviderUserIngestContext<T>(
  userId: string,
  context: ProviderIngestContext,
  callback: () => Promise<T>,
): Promise<T> {
  return runWithTokenUser(userId, () => runWithProviderIngestContext(context, callback));
}
