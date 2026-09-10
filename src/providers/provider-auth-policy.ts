import { CUSTOM_AUTH_SYNC_PROVIDER_IDS } from "../lib/custom-auth-providers.ts";
import { getProviderAuthTypeFromSetup, type Provider, type ProviderAuthSetup } from "./types.ts";

/**
 * Sync providers that read/write user-owned data without an external account.
 */
export const INTERNAL_SYNC_PROVIDER_IDS = new Set(["auto-supplements"]);

export function requiresPerUserConnect(providerId: string): boolean {
  if (INTERNAL_SYNC_PROVIDER_IDS.has(providerId)) return false;
  return true;
}

export function isImportOnlyProvider(provider: Provider): boolean {
  return "importOnly" in provider && provider.importOnly === true;
}

export type PerUserAuthComplianceResult =
  | { ok: true }
  | { ok: false; providerId: string; reason: string };

/**
 * Validates that a provider follows the per-user authentication policy.
 * Import-only and internal providers are exempt.
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

  const authType = getProviderAuthTypeFromSetup(setup);
  if (authType === "none") {
    return {
      ok: false,
      providerId: provider.id,
      reason: `authType is "none" — users must be able to connect this provider individually`,
    };
  }

  return { ok: true };
}
