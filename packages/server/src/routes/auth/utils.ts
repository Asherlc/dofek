import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import type { TokenSet } from "dofek/auth/oauth";
import { escapeAttribute, escapeText } from "entities";
import type { IdentityProviderName } from "../../auth/providers.ts";
import { queryCache } from "../../lib/cache.ts";
import { logger } from "../../logger.ts";

export function escapeHtml(str: string): string {
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

export function sanitizeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return undefined;
  return returnTo;
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
  db: import("dofek/db").Database;
  provider: import("dofek/providers/types").Provider;
  providerName: string;
  apiBaseUrl?: string;
  tokens: TokenSet;
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

  try {
    const { isWebhookProvider } = await import("dofek/providers/types");
    if (isWebhookProvider(params.provider)) {
      const { registerWebhookForProvider } = await import("../webhooks.ts");
      await registerWebhookForProvider(params.db, params.provider);
      logger.info(`[auth] Webhook registered for ${params.provider.id}`);
    }
  } catch (webhookErr: unknown) {
    logger.warn(`[auth] Failed to register webhook for ${params.provider.id}: ${webhookErr}`);
  }
}

export function isIdentityProviderName(value: string): value is IdentityProviderName {
  return (IDENTITY_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function getSinglePathParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}
