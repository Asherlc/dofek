import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import { queryCache } from "dofek/lib/cache";
import { escapeAttribute, escapeText } from "entities";
import rateLimit from "express-rate-limit";
import type { IdentityProviderName } from "../../auth/providers.ts";
import {
  getIdentityFlowStore,
  type IdentityFlowEntry,
  type IdentityFlowStore,
} from "../../lib/identity-flow-store.ts";
import {
  InMemoryMobileAuthExchangeStore,
  type MobileAuthExchangeStore,
  RedisMobileAuthExchangeStore,
} from "../../lib/mobile-auth-exchange-store.ts";
import {
  getOAuth1SecretStore,
  getOAuthStateStore,
  type OAuth1SecretStore,
  type OAuthStateStore,
} from "../../lib/oauth-state-store.ts";
import {
  getPendingEmailSignupStore,
  type PendingEmailSignupStore,
} from "../../lib/pending-email-signup-store.ts";
import { logger } from "../../logger.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Build the HTML page shown in the OAuth popup after successful authorization.
 * Includes a BroadcastChannel message + window.close() so the parent window
 * detects the completion and refreshes provider status automatically.
 */
export function oauthSuccessHtml(
  providerName: string,
  detail?: string,
  providerId?: string,
): string {
  const safeProviderName = escapeHtml(providerName);
  const safeDetail = detail ? `<p>${escapeHtml(detail)}</p>` : "";
  // Ensure JSON payloads don't contain </script> to prevent script injection
  const broadcastPayload = JSON.stringify({ type: "complete", providerId }).replace(
    /<\/script/gi,
    "\\u003c/script",
  );
  const postMessagePayload = JSON.stringify({ type: "oauth-complete", providerId }).replace(
    /<\/script/gi,
    "\\u003c/script",
  );
  return `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${safeProviderName} connected successfully.</p>${safeDetail}<p><a href="/" style="color:#10b981">Return to dashboard</a></p></div><script>try{new BroadcastChannel('oauth-complete').postMessage(${broadcastPayload})}catch(e){}try{window.opener&&window.opener.postMessage(${postMessagePayload},'*')}catch(e){}setTimeout(function(){window.close()},1500)</script></body></html>`;
}

let oauthStateStore: OAuthStateStore;
let oauth1SecretStore: OAuth1SecretStore;
let mobileAuthExchangeStore: MobileAuthExchangeStore;
let pendingEmailSignupStore: PendingEmailSignupStore;

/**
 * Server-side state store for identity provider OAuth flows.
 * Cookies (SameSite=Lax) aren't sent on cross-site POST requests, which
 * breaks Apple Sign In (response_mode=form_post). Backed by Redis so state
 * survives server restarts and works across multiple instances.
 */
let identityFlowStore: IdentityFlowStore;

// Module-level db reference, set during router creation
let db: import("dofek/db").Database;

export function initAuthStores(database: import("dofek/db").Database): void {
  db = database;
  identityFlowStore = getIdentityFlowStore();
  oauthStateStore = getOAuthStateStore();
  oauth1SecretStore = getOAuth1SecretStore();
  pendingEmailSignupStore = getPendingEmailSignupStore();
  mobileAuthExchangeStore =
    process.env.NODE_ENV === "test"
      ? new InMemoryMobileAuthExchangeStore()
      : new RedisMobileAuthExchangeStore();
}

export function getDb(): import("dofek/db").Database {
  return db;
}

export function getOAuthStateStoreRef(): OAuthStateStore {
  return oauthStateStore;
}

export function getOAuth1SecretStoreRef(): OAuth1SecretStore {
  return oauth1SecretStore;
}

export function getIdentityFlowStoreRef(): IdentityFlowStore {
  return identityFlowStore;
}

export function getMobileAuthExchangeStoreRef(): MobileAuthExchangeStore {
  return mobileAuthExchangeStore;
}

export function getPendingEmailSignupStoreRef(): PendingEmailSignupStore {
  return pendingEmailSignupStore;
}

export async function storeIdentityFlow(state: string, entry: IdentityFlowEntry): Promise<void> {
  await identityFlowStore.save(state, entry);
}

export function sanitizeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!isSafeRelativeRedirect(returnTo)) return undefined;
  return returnTo;
}

const REDIRECT_BASE_ORIGIN = "https://dofek.local";

/** Validate that a redirect target stays on the app origin (CodeQL-safe open redirect guard). */
export function isSafeRelativeRedirect(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  try {
    return new URL(path, REDIRECT_BASE_ORIGIN).origin === REDIRECT_BASE_ORIGIN;
  } catch {
    return false;
  }
}

export function getPostLoginRedirect(returnTo: string | undefined, isNewUser: boolean): string {
  return sanitizeReturnTo(returnTo) ?? (isNewUser ? "/?newUser=true" : "/");
}

export function completeSignupHtml(
  providerName: string,
  token: string,
  email = "",
  error?: string,
): string {
  const escapedProviderName = escapeText(providerName);
  const escapedToken = escapeAttribute(token);
  const escapedEmail = escapeAttribute(email);
  const errorHtml = error
    ? `<p style="margin:0 0 16px;color:#fca5a5;font-size:14px">${escapeText(error)}</p>`
    : "";
  return `<html><body style="font-family:system-ui;background:#111827;color:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px"><div style="width:100%;max-width:420px;background:#1f2937;border:1px solid #374151;border-radius:16px;padding:32px;box-sizing:border-box"><h1 style="margin:0 0 12px;font-size:28px">Enter your email to finish signing in</h1><p style="margin:0 0 20px;color:#d1d5db;line-height:1.5">${escapedProviderName} does not provide your email address, so we need it before creating your account.</p>${errorHtml}<form method="post" action="/auth/complete-signup" style="display:flex;flex-direction:column;gap:16px"><input type="hidden" name="token" value="${escapedToken}" /><label style="display:flex;flex-direction:column;gap:8px;font-size:14px;color:#e5e7eb"><span>Email</span><input type="email" name="email" value="${escapedEmail}" autocomplete="email" required style="border:1px solid #4b5563;border-radius:10px;padding:12px 14px;background:#111827;color:#f9fafb;font-size:16px" /></label><button type="submit" style="border:0;border-radius:10px;padding:12px 16px;background:#10b981;color:#06281f;font-size:16px;font-weight:700;cursor:pointer">Continue</button></form></div></body></html>`;
}

export async function persistProviderConnection(params: {
  db: import("dofek/db").SyncDatabase;
  provider: import("dofek/providers/types").Provider;
  providerName: string;
  apiBaseUrl?: string;
  tokens: import("dofek/auth/oauth").TokenSet;
  userId: string;
}): Promise<void> {
  const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
  await ensureProvider(
    params.db,
    params.provider.id,
    params.providerName,
    params.apiBaseUrl,
    params.userId,
  );
  await saveTokens(params.db, params.provider.id, params.tokens, params.userId);
  await queryCache.invalidateByPrefix(`${params.userId}:sync.providers`);

  logger.info(
    `[auth] ${params.provider.id} tokens saved for user ${params.userId}. Expires: ${params.tokens.expiresAt.toISOString()}`,
  );

  const { isWebhookProvider } = await import("dofek/providers/types");
  if (isWebhookProvider(params.provider)) {
    const { registerWebhookForProvider } = await import("../webhooks.ts");
    await registerWebhookForProvider(params.db, params.provider, params.userId);
    logger.info(`[auth] Webhook registered for ${params.provider.id}`);
  }
}

export function isIdentityProviderName(value: string): value is IdentityProviderName {
  return IDENTITY_PROVIDER_NAMES.some((p) => p === value);
}

export function getSinglePathParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

// Rate limiter for auth endpoints (login, callback, native sign-in)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 attempts per window per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many authentication attempts — please try again later",
});
