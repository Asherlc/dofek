import { providerSourceLabel } from "@dofek/providers/providers";
import type { ProviderLookup, SourceLink } from "./activity-source-attribution.ts";

/** User-facing explanation of how multi-source activity records were combined. */
export interface ActivitySourceDecisionDetail {
  sourceCount: number;
  primarySourceLabel: string;
  explanation: string;
}

/**
 * Derives a concise source-priority explanation for multi-source activities.
 * Single-source activities have no conflict to explain.
 */
export function buildActivitySourceDecision(
  providerId: string,
  subsource: string | null,
  sourceLinks: SourceLink[],
  lookupProvider?: ProviderLookup,
): ActivitySourceDecisionDetail | null {
  if (sourceLinks.length < 2) {
    return null;
  }

  const primarySourceLabel = primarySourceLabelFor(
    providerId,
    subsource,
    sourceLinks,
    lookupProvider,
  );

  return {
    sourceCount: sourceLinks.length,
    primarySourceLabel,
    explanation: `${primarySourceLabel} was selected as the primary record by source priority. Missing details may come from the other matched sources.`,
  };
}

function primarySourceLabelFor(
  providerId: string,
  subsource: string | null,
  sourceLinks: SourceLink[],
  lookupProvider?: ProviderLookup,
): string {
  const matchingLink = sourceLinks.find(
    (link) => link.providerId === providerId && (link.subsource ?? null) === subsource,
  );
  if (matchingLink) {
    return matchingLink.label;
  }

  if (subsource) {
    return providerSourceLabel(providerId, subsource);
  }

  return lookupProvider?.(providerId)?.name ?? providerSourceLabel(providerId);
}
