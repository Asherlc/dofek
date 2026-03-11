import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";

/**
 * Auth setup returned by providers that use OAuth.
 */
export interface ProviderAuthSetup {
  oauthConfig: OAuthConfig;
  /** Override the authorization URL (e.g. with PKCE challenge baked in) */
  authUrl?: string;
  exchangeCode: (code: string) => Promise<TokenSet>;
  apiBaseUrl?: string;
  /** Automated login that drives the OAuth flow with credentials (no browser needed) */
  automatedLogin?: (email: string, password: string) => Promise<TokenSet>;
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
   * Providers without OAuth (e.g. API-key-only) return undefined.
   */
  authSetup?(): ProviderAuthSetup;

  /**
   * Pull data from the provider API and upsert into the database.
   * @param db - Drizzle database instance
   * @param since - Only sync data after this date (incremental sync)
   */
  sync(db: Database, since: Date): Promise<SyncResult>;
}

/**
 * Configuration for a provider, loaded from environment variables.
 */
export const providerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  athleteId: z.string().optional(),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
