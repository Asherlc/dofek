import { formatDateTime } from "@dofek/format/format";
import { PROVIDER_CATALOG, providerCatalogEntry } from "./provider-catalog.ts";

/** Display labels for provider IDs, shared across web and iOS. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).map(([id, entry]) => [id, entry.label]),
);

/** Human-readable label for a provider ID, falling back to the raw ID. */
export function providerLabel(id: string): string {
  return providerCatalogEntry(id)?.label ?? id;
}

export interface ProviderProvenance {
  providerId: string;
  label: string;
}

export function resolveProviderProvenance(providerId: string): ProviderProvenance {
  return { providerId, label: providerLabel(providerId) };
}

export function providerSourceLabel(id: string, subsource?: string | null): string {
  if (id === "apple_health" && subsource) return `${subsource} (via Apple Health)`;
  return providerLabel(id);
}

export function providerRecordLabel(id: string, sourceName?: string | null): string {
  const label = providerLabel(id);
  const source = sourceName?.trim();
  if (!source) return label;
  const normalizedSource = source.toLowerCase();
  if (normalizedSource === id.toLowerCase() || normalizedSource === label.toLowerCase()) {
    return label;
  }
  return `${label} · ${source}`;
}

export interface ProviderAbsentSource {
  providerId: string;
  providerAbsentAt: string | null;
  subsource?: string | null;
}

export function formatProviderAbsentTombstoneSummary(
  providerId: string,
  providerAbsentAt: string,
  subsource?: string | null,
): string {
  return `Removed from ${providerSourceLabel(providerId, subsource)} · ${formatDateTime(providerAbsentAt)}`;
}

export function formatProviderPartialAbsenceSummary(
  sources: ProviderAbsentSource[],
): string | null {
  if (sources.length === 0) return null;
  return sources
    .map((source) => {
      const removedAt = source.providerAbsentAt
        ? ` · ${formatDateTime(source.providerAbsentAt)}`
        : "";
      return `${providerSourceLabel(source.providerId, source.subsource)} removed${removedAt}`;
    })
    .join(", ");
}

export function providerAbsentExplanation(id: string, subsource?: string | null): string {
  if (id === "apple_health" && subsource) {
    return `The Apple Health copy of this workout (originally from ${subsource}) was removed from sync. This does not mean ${subsource} deleted the activity.`;
  }
  return `This activity was hidden because ${providerSourceLabel(id, subsource)} reported it as deleted or missing.`;
}

export const SVG_LOGOS: ReadonlySet<string> = new Set(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.logo?.type === "svg")
    .map(([id, entry]) => entry.logo?.id ?? id),
);

export const PNG_LOGOS: ReadonlySet<string> = new Set(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.logo?.type === "png")
    .map(([id, entry]) => entry.logo?.id ?? id),
);

export const BRAND_COLORS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.brandColor)
    .map(([id, entry]) => [id, entry.brandColor]),
);

export function providerLogoType(id: string): "svg" | "png" | null {
  return providerCatalogEntry(id)?.logo?.type ?? null;
}

export function providerLogoId(id: string): string {
  return providerCatalogEntry(id)?.logo?.id ?? id;
}
