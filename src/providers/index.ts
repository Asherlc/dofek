import { isSyncProvider, type Provider, type SyncProvider } from "./types.ts";

/**
 * Registry of all available providers.
 * New providers register themselves here.
 */
const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Provider '${provider.id}' is already registered`);
  }
  providers.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function getAllProviders(): Provider[] {
  return Array.from(providers.values());
}

/** Returns only providers that sync via API (excludes import-only providers). */
export function getSyncProviders(): SyncProvider[] {
  return getAllProviders().filter(isSyncProvider);
}

export function getEnabledProviders(): Provider[] {
  return getAllProviders().filter((p) => p.validate() === null);
}
