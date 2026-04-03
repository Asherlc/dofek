import { randomBytes } from "node:crypto";
import type {
  IdentityFlowEntry,
  OAuthStateEntry,
  PendingEmailSignupEntry,
} from "./types.ts";

export const oauthStateMap = new Map<string, OAuthStateEntry>();

// OAuth 1.0 request token secrets (keyed by oauth_token)
export const oauth1Secrets = new Map<
  string,
  { providerId: string; tokenSecret: string; userId: string }
>();

export const identityFlowMap = new Map<string, IdentityFlowEntry>();

export const pendingEmailSignupMap = new Map<string, PendingEmailSignupEntry>();

export function storeIdentityFlow(state: string, entry: IdentityFlowEntry): void {
  identityFlowMap.set(state, entry);
  setTimeout(() => identityFlowMap.delete(state), 10 * 60 * 1000);
}

export function storePendingEmailSignup(entry: PendingEmailSignupEntry): string {
  const token = randomBytes(16).toString("hex");
  pendingEmailSignupMap.set(token, entry);
  setTimeout(() => pendingEmailSignupMap.delete(token), 10 * 60 * 1000);
  return token;
}
