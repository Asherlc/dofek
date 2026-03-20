import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";

/**
 * OAuth 1.0 3-legged flow (e.g. FatSecret).
 */
export interface OAuth1Flow {
  getRequestToken: (
    callbackUrl: string,
  ) => Promise<{ oauthToken: string; oauthTokenSecret: string; authorizeUrl: string }>;
  exchangeForAccessToken: (
    requestToken: string,
    requestTokenSecret: string,
    oauthVerifier: string,
  ) => Promise<{ token: string; tokenSecret: string }>;
}

/**
 * Identity info extracted from a data provider's API after OAuth.
 * Enables using data providers as login/identity providers.
 */
export interface ProviderIdentity {
  providerAccountId: string;
  email: string | null;
  name: string | null;
}

/**
 * Auth setup returned by providers that use OAuth.
 */
export interface ProviderAuthSetup {
  oauthConfig: OAuthConfig;
  /** Override the authorization URL (e.g. with PKCE challenge baked in) */
  authUrl?: string;
  exchangeCode: (code: string, codeVerifier?: string) => Promise<TokenSet>;
  apiBaseUrl?: string;
  /** Automated login that drives the OAuth flow with credentials (no browser needed) */
  automatedLogin?: (email: string, password: string) => Promise<TokenSet>;
  /** OAuth 1.0 flow for providers that use 3-legged OAuth (e.g. FatSecret) */
  oauth1Flow?: OAuth1Flow;
  /** Extract user identity from this provider (enables using it as a login provider) */
  getUserIdentity?: (accessToken: string) => Promise<ProviderIdentity>;
}

/**
 * Result of a single sync run for a provider.
 */
export interface SyncResult {
  provider: string;
  recordsSynced: number;
  errors: SyncError[];
  duration: number;
}

export interface SyncError {
  message: string;
  externalId?: string;
  cause?: unknown;
}

/**
 * Progress callback for reporting sync progress from within a provider.
 * @param percentage - Percentage complete (0–100)
 * @param message - Human-readable status message
 */
export type SyncProgressCallback = (percentage: number, message: string) => void;

// ============================================================
// Provider auth type discrimination
// ============================================================

/**
 * How a provider authenticates users.
 * - 'oauth': Standard OAuth 2.0 redirect flow (Strava, Fitbit, etc.)
 * - 'credential': User provides username/password, server authenticates (Eight Sleep, Zwift, etc.)
 * - 'file-import': No authentication needed, user uploads files
 * - 'oauth1': OAuth 1.0 3-legged flow (FatSecret)
 */
export type ProviderAuthType = "oauth" | "credential" | "file-import" | "oauth1";

/**
 * Every provider implements this interface.
 * The sync framework calls `sync()` on a schedule.
 */
export interface Provider {
  /** Unique provider ID — matches the `provider.id` in the DB */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** True for file-import-only providers (e.g. Strong CSV, Cronometer CSV) that have no API sync. */
  readonly importOnly?: boolean;

  /**
   * Validate that the provider is configured (API keys present, etc.)
   * Returns null if valid, or an error message if not.
   */
  validate(): string | null;

  /**
   * Returns OAuth configuration for providers that support the `auth` command.
   * Returns undefined if OAuth is not supported or not configured (e.g. missing env vars).
   * Call sites should treat undefined as "not available for login" and surface configuration errors to the user.
   */
  authSetup?(): ProviderAuthSetup | undefined;

  /**
   * Pull data from the provider API and upsert into the database.
   * @param db - Drizzle database instance
   * @param since - Only sync data after this date (incremental sync)
   * @param onProgress - Optional callback to report progress (0–100%)
   */
  sync(db: SyncDatabase, since: Date, onProgress?: SyncProgressCallback): Promise<SyncResult>;
}

// ============================================================
// Specialized provider interfaces
// ============================================================

/** Provider that authenticates via OAuth 2.0 redirect (Strava, Fitbit, Wahoo, etc.) */
export interface OAuthProvider extends Provider {
  authSetup(): ProviderAuthSetup;
}

/** Provider that authenticates via user-provided credentials (Eight Sleep, Zwift, etc.) */
export interface CredentialProvider extends Provider {
  authSetup(): ProviderAuthSetup & {
    automatedLogin: NonNullable<ProviderAuthSetup["automatedLogin"]>;
  };
}

/** Provider that uses file import only (Strong CSV, Cronometer CSV) */
export interface FileImportProvider extends Provider {
  readonly importOnly: true;
}

// ============================================================
// Runtime auth type detection
// ============================================================

/**
 * Detect a provider's authentication type from its interface.
 * Used by the sync router to tell the frontend which auth flow to use.
 */
export function getProviderAuthType(provider: Provider): ProviderAuthType | "none" {
  if (provider.importOnly) return "file-import";
  let setup: ProviderAuthSetup | undefined;
  try {
    setup = provider.authSetup?.();
  } catch {
    return "none";
  }
  if (!setup) return "none";
  if (setup.automatedLogin) return "credential";
  if (setup.oauth1Flow) return "oauth1";
  if (setup.oauthConfig) return "oauth";
  return "none";
}
