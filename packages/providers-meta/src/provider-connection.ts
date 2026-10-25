export const PROVIDER_MANUAL_CONNECTION_KINDS = ["public-profile", "access-token"] as const;

export type ProviderManualConnectionKind = (typeof PROVIDER_MANUAL_CONNECTION_KINDS)[number];

export interface ProviderManualConnectionMetadata {
  kind: ProviderManualConnectionKind;
  label: string;
  instructionsUrl: string;
}

export function isCloudPushProvider(provider: { pushOnly: boolean; authType: string }): boolean {
  return (
    provider.pushOnly &&
    provider.authType !== "none" &&
    provider.authType !== "push:mobile" &&
    provider.authType !== "file-import"
  );
}
