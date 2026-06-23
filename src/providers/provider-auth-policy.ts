import type { Provider, ProviderAuthSetup, ProviderAuthType } from "./types.ts";
import { CUSTOM_AUTH_SYNC_PROVIDER_IDS } from "./custom-auth-providers.ts";

/**
 * Sync providers that predated the per-user auth requirement and still use
 * deployment-wide user credentials (env vars) instead of a Connect flow.
 *
 * Do not add new provider IDs here — implement authSetup() instead.
 */
export const LEGACY_SERVER_SIDE_USER_AUTH_PROVIDER_IDS = new Set(["ultrahuman"]);

/**
 * Sync providers that read/write user-owned data without an external account.
 */
export const INTERNAL_SYNC_PROVIDER_IDS = new Set(["auto-supplements"]);

export function requiresPerUserConnect(providerId: string): boolean {
  if (LEGACY_SERVER_SIDE_USER_AUTH_PROVIDER_IDS.has(providerId)) return false;
  if (INTERNAL_SYNC_PROVIDER_IDS.has(providerId)) return false;
  return true;
}

export function isImportOnlyProvider(provider: Provider): boolean {
  return "importOnly" in provider && provider.importOnly === true;
}

export type PerUserAuthComplianceResult =
  | { ok: true }
  | { ok: false; providerId: string; reason: string };

function getAuthTypeFromSetup(setup: ProviderAuthSetup): ProviderAuthType | "none" {
  if (setup.automatedLogin) return "credential";
  if (setup.oauth1Flow) return "oauth1";
  if (setup.oauthConfig && setup.exchangeCode) return "oauth";
  return "none";
}

/**
 * Validates that a provider follows the per-user authentication policy.
 * Import-only, internal, and legacy providers are exempt.
 */
export function checkPerUserAuthCompliance(provider: Provider): PerUserAuthComplianceResult {
  if (isImportOnlyProvider(provider)) {
    return { ok: true };
  }

  if (!requiresPerUserConnect(provider.id)) {
    return { ok: true };
  }

  if (CUSTOM_AUTH_SYNC_PROVIDER_IDS.has(provider.id)) {
    return { ok: true };
  }

  if (typeof provider.authSetup !== "function") {
    return {
      ok: false,
      providerId: provider.id,
      reason:
        "missing authSetup() — new sync providers must store credentials per user (OAuth, credential login, or custom auth router)",
    };
  }

  let setup: ProviderAuthSetup | undefined;
  try {
    setup = provider.authSetup();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      providerId: provider.id,
      reason: `authSetup() threw: ${message}`,
    };
  }

  if (!setup) {
    return {
      ok: false,
      providerId: provider.id,
      reason: "authSetup() returned undefined — app OAuth credentials must be configured",
    };
  }

  const authType = getAuthTypeFromSetup(setup);
  if (authType === "none") {
    return {
      ok: false,
      providerId: provider.id,
      reason: `authType is "none" — users must be able to connect this provider individually`,
    };
  }

  return { ok: true };
}
