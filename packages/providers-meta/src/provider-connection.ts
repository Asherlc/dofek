export const PROVIDER_MANUAL_CONNECTION_KINDS = ["public-profile", "access-token"] as const;

export type ProviderManualConnectionKind = (typeof PROVIDER_MANUAL_CONNECTION_KINDS)[number];

export interface ProviderManualConnectionMetadata {
  kind: ProviderManualConnectionKind;
  label: string;
  instructionsUrl: string;
}
