/** UI auth type overrides for providers with dedicated connect routers. */
export const CUSTOM_AUTH_PROVIDERS: Record<string, string> = {
  whoop: "custom:whoop",
  garmin: "custom:garmin",
};

/**
 * Sync providers whose connect flow lives outside authSetup() (e.g. dedicated
 * tRPC routers). They still require stored tokens before sync runs.
 */
export const CUSTOM_AUTH_SYNC_PROVIDER_IDS = new Set<string>(["whoop"]);

export function providerRequiresStoredTokens(provider: {
  id: string;
  authSetup?: unknown;
}): boolean {
  return provider.authSetup !== undefined || CUSTOM_AUTH_SYNC_PROVIDER_IDS.has(provider.id);
}
