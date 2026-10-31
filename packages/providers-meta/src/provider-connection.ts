import { type ProviderCredentialIdentifier, providerCatalogEntry } from "./provider-catalog.ts";

export const PROVIDER_MANUAL_CONNECTION_KINDS = ["public-profile", "access-token"] as const;

export type ProviderManualConnectionKind = (typeof PROVIDER_MANUAL_CONNECTION_KINDS)[number];

export interface ProviderManualConnectionMetadata {
  kind: ProviderManualConnectionKind;
  label: string;
  instructionsUrl: string;
  description?: string;
}

export function providerCredentialInput(providerId: string) {
  const metadata = providerCatalogEntry(providerId);
  const identifier = metadata?.credentialIdentifier ?? "email";
  return {
    identifier,
    label: identifier === "username" ? "Username" : "Email",
    placeholder: identifier === "username" ? "Your username" : "you@example.com",
    instructions: metadata?.credentialInstructions,
  };
}

export function providerCredentialSubmitHint(
  username: string,
  password: string,
  loading: boolean,
  identifier: ProviderCredentialIdentifier = "email",
) {
  if (loading) return null;
  if (!username.trim() && !password) return `Enter your ${identifier} and password to continue.`;
  if (!username.trim()) return `Enter your ${identifier} to continue.`;
  if (!password) return "Enter your password to continue.";
  return null;
}

export function isCloudPushProvider(provider: { pushOnly: boolean; authType: string }): boolean {
  return (
    provider.pushOnly &&
    provider.authType !== "none" &&
    provider.authType !== "push:mobile" &&
    provider.authType !== "file-import"
  );
}
