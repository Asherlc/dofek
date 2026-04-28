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

export interface ProviderIdentityCapabilities {
  /** Whether the provider reliably supplies the user's email during identity lookup. */
  providesEmail: boolean;
}

/**
 * Auth setup returned by providers that use OAuth.
 */
export interface ProviderAuthSetup {
  oauthConfig: OAuthConfig;
  /** Override the authorization URL (e.g. with PKCE challenge baked in) */
  authUrl?: string;
  exchangeCode: (code: string, codeVerifier?: string) => Promise<TokenSet>;
  /** Provider-specific cleanup before exchanging a new auth code. */
  revokeExistingTokens?: (tokens: TokenSet) => Promise<void>;
  apiBaseUrl?: string;
  /** Automated login that drives the OAuth flow with credentials (no browser needed) */
  automatedLogin?: (email: string, password: string) => Promise<TokenSet>;
  /** OAuth 1.0 flow for providers that use 3-legged OAuth (e.g. FatSecret) */
  oauth1Flow?: OAuth1Flow;
  /** Extract user identity from this provider (enables using it as a login provider) */
  getUserIdentity?: (accessToken: string) => Promise<ProviderIdentity>;
  /** Provider-specific identity traits used to drive signup/login behavior. */
  identityCapabilities?: ProviderIdentityCapabilities;
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

export interface SyncCheckpointStore {
  load(): Promise<unknown | null>;
  save(checkpoint: unknown): Promise<void>;
  clear(): Promise<void>;
}

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
   * Returns a deep link URL to view a specific activity on the provider's
   * website/app, or null if the provider doesn't support activity deep links.
   */
  activityUrl?(externalId: string): string;

  /**
   * Returns OAuth configuration for providers that support the `auth` command.
   * Returns undefined if OAuth is not supported or not configured (e.g. missing env vars).
   * Call sites should treat undefined as "not available for login" and surface configuration errors to the user.
   */
  authSetup?(options?: { host?: string }): ProviderAuthSetup | undefined;
}

/**
 * Options for a sync run, passed as a bag so we can extend without adding positional params.
 */
export interface SyncOptions {
  /** Callback to report progress (0–100%) */
  onProgress?: SyncProgressCallback;
  /** User ID for attributing sync log entries */
  userId?: string;
  /** Provider-owned checkpoint state for retryable job resumes */
  checkpoint?: SyncCheckpointStore;
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
   * @param options - Optional sync options (progress callback, userId, etc.)
   */
  sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult>;
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

// ============================================================
// Specialized provider interfaces
// ============================================================

/** Provider that authenticates via OAuth 2.0 redirect (Strava, Fitbit, Wahoo, etc.) */
export interface OAuthProvider extends SyncProvider {
  authSetup(options?: { host?: string }): ProviderAuthSetup;
}

/** Provider that authenticates via user-provided credentials (Eight Sleep, Zwift, etc.) */
export interface CredentialProvider extends SyncProvider {
  authSetup(options?: { host?: string }): ProviderAuthSetup & {
    automatedLogin: NonNullable<ProviderAuthSetup["automatedLogin"]>;
  };
}

/** Provider that uses file import only (Strong CSV, Cronometer CSV) */
export interface FileImportProvider extends ImportProvider {}

// ============================================================
// Webhook support
// ============================================================

/**
 * An event parsed from an incoming webhook payload.
 * Used to determine which user needs a sync.
 */
export interface WebhookEvent {
  /** Provider-specific owner/user ID (e.g., Strava athlete_id, Fitbit user_id) */
  ownerExternalId: string;
  /** What happened */
  eventType: "create" | "update" | "delete";
  /** What kind of object changed (activity, sleep, body, etc.) */
  objectType: string;
  /** External ID of the changed object (if available) */
  objectId?: string;
  /**
   * Provider-specific metadata carried through to syncWebhookEvent().
   * Can include the full payload (Wahoo, Concept2, Suunto), a date (Fitbit),
   * a time range (Withings), or any other context needed for targeted sync.
   */
  metadata?: Record<string, unknown>;
}

/**
 * A provider that supports receiving webhook push notifications.
 * Extends SyncProvider — webhooks trigger targeted syncs via the existing sync pipeline.
 *
 * Webhook registration can be either:
 * - **App-level** (Strava): one subscription for the entire app, registered once
 * - **Per-user** (Fitbit, Withings): subscription created per connected user
 */
export interface WebhookProvider extends SyncProvider {
  /**
   * Register a webhook subscription with the provider API.
   * For app-level webhooks: called once during setup.
   * For per-user webhooks: called after OAuth token exchange.
   *
   * @param callbackUrl - The URL the provider should POST events to
   * @param verifyToken - Random token for validation challenges
   * @returns Registration result with subscription ID and optional signing secret
   */
  registerWebhook(
    callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }>;

  /**
   * Unregister a webhook subscription.
   * Called when a user disconnects or when cleaning up.
   */
  unregisterWebhook(subscriptionId: string): Promise<void>;

  /**
   * Verify an incoming webhook request's authenticity.
   * Each provider has its own signature scheme (HMAC-SHA256, HMAC-SHA1, etc.).
   *
   * @param rawBody - The raw request body bytes
   * @param headers - HTTP request headers
   * @param signingSecret - The secret/token used for verification
   * @returns true if the signature is valid
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    signingSecret: string,
  ): boolean;

  /**
   * Parse a webhook payload to extract events.
   * Each event identifies the affected user and what changed.
   */
  parseWebhookPayload(body: unknown): WebhookEvent[];

  /**
   * Process a single webhook event efficiently — fetch/upsert only the
   * specific data that changed, instead of running a full sync().
   *
   * Returns a SyncResult describing what was synced.
   * If not implemented, the webhook router falls back to a full sync().
   */
  syncWebhookEvent?(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult>;

  /**
   * Handle provider-specific validation challenges (e.g., Strava's hub.challenge).
   * Called on GET requests to the webhook URL.
   * Returns the challenge response body, or null if not applicable.
   */
  handleValidationChallenge?(query: Record<string, string>, verifyToken: string): unknown | null;

  /** Whether this is an app-level (single) or per-user subscription */
  readonly webhookScope: "app" | "user";
}

/** Type guard: narrows a Provider to WebhookProvider. */
export function isWebhookProvider(provider: Provider): provider is WebhookProvider {
  return "registerWebhook" in provider && typeof provider.registerWebhook === "function";
}

// ============================================================
// Runtime auth type detection
// ============================================================

/**
 * Detect a provider's authentication type from its interface.
 * Used by the sync router to tell the frontend which auth flow to use.
 */
export function getProviderAuthType(provider: Provider): ProviderAuthType | "none" {
  if ("importOnly" in provider && provider.importOnly === true) return "file-import";
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
