/**
 * Wraps a raw Provider plugin with derived state (connection status, auth type, etc.).
 * Providers that define `authSetup` require authentication — they are only connected
 * when tokens exist in the database.
 */
export class ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly importOnly: boolean;
  readonly authType: string;
  readonly isConnected: boolean;
  readonly lastSyncedAt: string | null;

  constructor(
    provider: { id: string; name: string; importOnly?: boolean; authSetup?(): unknown },
    tokenSet: Set<string>,
    lastSyncMap?: Map<string, string>,
    customAuthOverrides?: Record<string, string>,
  ) {
    this.id = provider.id;
    this.name = provider.name;
    this.importOnly = provider.importOnly === true;

    let authType = "none";
    if (this.importOnly) {
      authType = "file-import";
    } else {
      try {
        const setup = provider.authSetup?.();
        if (setup && typeof setup === "object") {
          if ("automatedLogin" in setup && setup.automatedLogin) {
            authType = "credential";
          } else if ("oauth1Flow" in setup && setup.oauth1Flow) {
            authType = "oauth1";
          } else if ("oauthConfig" in setup && setup.oauthConfig) {
            authType = "oauth";
          }
        }
      } catch {
        /* credentials not configured */
      }
    }

    this.authType = customAuthOverrides?.[provider.id] ?? authType;
    const needsAuth = this.authType !== "none" && this.authType !== "file-import";
    this.isConnected = needsAuth ? tokenSet.has(provider.id) : true;
    this.lastSyncedAt = lastSyncMap?.get(provider.id) ?? null;
  }
}
