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
 * @param pct - Percentage complete (0–100)
 * @param message - Human-readable status message
 */
export type SyncProgressCallback = (pct: number, message: string) => void;

/**
 * Every provider implements this interface.
 * The sync framework calls `sync()` on a schedule.
 */
export interface Provider {
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

  /**
   * Pull data from the provider API and upsert into the database.
   * @param db - Drizzle database instance
   * @param since - Only sync data after this date (incremental sync)
   * @param onProgress - Optional callback to report progress (0–100%)
   */
  sync(db: SyncDatabase, since: Date, onProgress?: SyncProgressCallback): Promise<SyncResult>;
}
