import { providerLabel } from "./providers.ts";

export interface HealthProvenance {
  latestDate: string | null;
  sourceProviders: string[];
  observedDays: number;
  windowDays: number;
}

export function formatHealthProvenanceSource(provenance: HealthProvenance): string {
  const sourceLabels = provenance.sourceProviders.map(providerLabel);
  return sourceLabels.length > 0 ? sourceLabels.join(", ") : "Unknown source";
}

export function formatHealthProvenanceSummary(provenance: HealthProvenance): string {
  const latestText = provenance.latestDate
    ? `latest ${provenance.latestDate}`
    : "latest unavailable";
  return `${formatHealthProvenanceSource(provenance)} · ${provenance.observedDays}/${provenance.windowDays} days · ${latestText}`;
}
