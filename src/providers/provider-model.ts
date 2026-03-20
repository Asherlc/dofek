/**
 * Wraps a raw Provider plugin with derived state (connection status, auth type, etc.).
 * Providers that define `authSetup` require authentication — they are only connected
 * when tokens exist in the database.
 */
export class ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly importOnly: boolean;
  readonly needsOAuth: boolean;
  readonly needsCustomAuth: boolean;
  readonly isConnected: boolean;
  readonly lastSyncedAt: string | null;

  constructor(
    provider: { id: string; name: string; importOnly?: boolean; authSetup?(): unknown },
    tokenSet: Set<string>,
    lastSyncMap?: Map<string, string>,
  ) {
    this.id = provider.id;
    this.name = provider.name;
    this.importOnly = provider.importOnly === true;

    let hasOAuthConfig = false;
    try {
      const setup = provider.authSetup?.();
      hasOAuthConfig =
        typeof setup === "object" &&
        setup !== null &&
        "oauthConfig" in setup &&
        !!setup.oauthConfig;
    } catch {
      /* credentials not configured */
    }

    this.needsOAuth = hasOAuthConfig;
    this.needsCustomAuth = !!provider.authSetup && !hasOAuthConfig;
    this.isConnected = !provider.authSetup || tokenSet.has(provider.id);
    this.lastSyncedAt = lastSyncMap?.get(provider.id) ?? null;
  }
}
