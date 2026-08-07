import type { ProviderStats } from "@dofek/providers/provider-stats";
import type { ImportProviderId } from "../../lib/share-import";
import { getFileImportProviderConfig } from "./file-import-providers.ts";
import { type Provider, ProviderCard } from "./provider-card.tsx";

export function FileImportProviderCard({
  provider,
  stats,
  syncing,
  importing,
  syncProgress,
  onSync,
  onConnect,
  onImportProvider,
  onPress,
}: {
  provider: Provider;
  stats: ProviderStats | undefined;
  syncing: boolean;
  importing?: boolean;
  syncProgress: { percentage?: number; message?: string; failedCount?: number } | undefined;
  onSync: () => void;
  onConnect: () => void;
  onImportProvider: (providerId: ImportProviderId) => void;
  onPress: () => void;
}) {
  const providerConfig = getFileImportProviderConfig(provider.id);
  return (
    <ProviderCard
      provider={provider}
      stats={stats}
      syncing={syncing}
      importing={importing}
      syncProgress={syncProgress}
      onSync={onSync}
      onConnect={onConnect}
      onImport={providerConfig ? () => onImportProvider(providerConfig.providerId) : undefined}
      onPress={onPress}
    />
  );
}
