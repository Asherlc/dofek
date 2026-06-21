export interface SleepProvenance {
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
}

export interface SleepProvenanceSnakeCase {
  provider_id: string | null;
  source_name: string | null;
  source_providers: string[];
}

export function formatProviderId(id: string): string {
  return id
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatSleepProvenance(
  row: SleepProvenance | SleepProvenanceSnakeCase,
): { primary: string; alsoFrom: string | null } {
  const providerId = "providerId" in row ? row.providerId : row.provider_id;
  const sourceName = "sourceName" in row ? row.sourceName : row.source_name;
  const sourceProviders =
    "sourceProviders" in row ? row.sourceProviders : row.source_providers ?? [];

  const provider = providerId ? formatProviderId(providerId) : "Unknown";
  const primary =
    sourceName && sourceName.toLowerCase() !== providerId?.toLowerCase()
      ? `${provider} · ${sourceName}`
      : provider;

  const alsoFrom = sourceProviders
    .filter((id) => id !== providerId)
    .map(formatProviderId)
    .join(", ");

  return { primary, alsoFrom: alsoFrom || null };
}
