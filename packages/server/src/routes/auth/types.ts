import type { TokenSet } from "dofek/auth/oauth";

export interface OAuthStateEntry {
  providerId: string;
  codeVerifier?: string;
  intent: "data" | "login" | "link";
  linkUserId?: string;
  userId: string;
  /** Mobile app URL scheme for deep link redirect after OAuth. */
  mobileScheme?: string;
  returnTo?: string;
}

/**
 * Server-side state store for identity provider OAuth flows.
 * Cookies (SameSite=Lax) aren't sent on cross-site POST requests, which
 * breaks Apple Sign In (response_mode=form_post). This map provides a
 * fallback when cookies are unavailable.
 */
export interface IdentityFlowEntry {
  codeVerifier: string;
  linkUserId?: string;
  mobileScheme?: string;
  returnTo?: string;
}

export interface PendingEmailSignupEntry {
  providerId: string;
  providerName: string;
  apiBaseUrl?: string;
  identity: {
    providerAccountId: string;
    email: null;
    name: string | null;
  };
  tokens: TokenSet;
  mobileScheme?: string;
  returnTo?: string;
}
