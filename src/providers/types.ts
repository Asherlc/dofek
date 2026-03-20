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

/**
 * Common fields shared by all providers (sync and import).
 */
interface BaseProvider {
  /** Unique provider ID — matches the `provider.id` in the DB */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

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
}

/**
 * A provider that syncs data from an API on a schedule.
 * The sync framework calls `sync()` periodically.
 */
export interface SyncProvider extends BaseProvider {
  /**
   * Pull data from the provider API and upsert into the database.
   * @param db - Drizzle database instance
   * @param since - Only sync data after this date (incremental sync)
   * @param onProgress - Optional callback to report progress (0–100%)
   */
  sync(db: SyncDatabase, since: Date, onProgress?: SyncProgressCallback): Promise<SyncResult>;
}

/**
 * A file-import-only provider (e.g. Strong CSV, Cronometer CSV) that has no API sync.
 * Data is imported via dedicated import functions, not via `sync()`.
 */
export interface ImportProvider extends BaseProvider {
  readonly importOnly: true;
}

/**
 * Union of all provider types. Use `isSyncProvider()` to narrow.
 */
export type Provider = SyncProvider | ImportProvider;

/** Type guard: narrows a Provider to SyncProvider. */
export function isSyncProvider(provider: Provider): provider is SyncProvider {
  return !("importOnly" in provider && provider.importOnly === true);
}
