import { AsyncLocalStorage } from "node:async_hooks";

interface ProviderTokenDiagnostic {
  expiresAt: string;
  hasRefreshToken: boolean;
}

const contextStorage = new AsyncLocalStorage<{
  userId: string;
  providerTokens: Map<string, ProviderTokenDiagnostic>;
}>();

export function runWithProviderTokenDiagnostics<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return contextStorage.run({ userId, providerTokens: new Map() }, callback);
}

export function setProviderTokenDiagnostic(
  providerId: string,
  userId: string | undefined,
  diagnostic: ProviderTokenDiagnostic | undefined,
): void {
  const context = contextStorage.getStore();
  if (!context || context.userId !== userId) return;
  if (diagnostic) context.providerTokens.set(providerId, diagnostic);
  else context.providerTokens.delete(providerId);
}

export function getProviderTokenDiagnostic(
  providerId: string,
  userId: string | undefined,
): ProviderTokenDiagnostic | undefined {
  const context = contextStorage.getStore();
  return context?.userId === userId ? context?.providerTokens.get(providerId) : undefined;
}
