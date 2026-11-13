export interface ProviderDangerZoneCopy {
  deleteDescription: string;
  disconnectActionLabel: string;
  disconnectDescription: string;
  disconnectPendingLabel: string;
  disconnectTitle: string;
}

/** Shared user-facing impact copy for provider disconnect and data deletion. */
export function providerDangerZoneCopy(providerName: string): ProviderDangerZoneCopy {
  return {
    deleteDescription: `Permanently delete every ${providerName} record from Dofek. This does not change whether ${providerName} is connected.`,
    disconnectActionLabel: `Disconnect ${providerName}`,
    disconnectDescription: `Disconnecting ${providerName} removes its saved authorization and stops future syncs. Data already imported into Dofek is kept.${providerName === "theCrag" ? " If you issued a personal API key, revoke it in theCrag Settings > API Keys before disconnecting." : ""}`,
    disconnectPendingLabel: `Disconnecting ${providerName}...`,
    disconnectTitle: `Disconnect ${providerName}?`,
  };
}
