import { providerSourceLabel } from "@dofek/providers/providers";
import type { ProviderLookup, SourceLink } from "./activity-source-attribution.ts";

/** User-facing explanation of how multi-source activity records were combined. */
export interface ActivitySourceDecisionDetail {
  sourceCount: number;
  primarySourceLabel: string;
  explanation: string;
}

/** Compact source provenance rendered on activity list cards. */
export interface ActivityListSourceDetail {
  primarySourceLabel: string;
  sourceCount: number;
  overlapSummary: string | null;
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

/** Builds list-card provenance from the same source-priority semantics as activity detail. */
export function buildActivityListSource(
  providerId: string,
  subsource: string | null,
  sourceLinks: SourceLink[] | undefined,
  lookupProvider?: ProviderLookup,
): ActivityListSourceDetail {
  if (sourceLinks === undefined) {
    return {
      primarySourceLabel: primarySourceLabelFor(providerId, subsource, sourceLinks, lookupProvider),
      sourceCount: 1,
      overlapSummary: null,
    };
  }

  const decision = buildActivitySourceDecision(providerId, subsource, sourceLinks, lookupProvider);
  const primarySourceLabel =
    decision?.primarySourceLabel ??
    primarySourceLabelFor(providerId, subsource, sourceLinks, lookupProvider);

  return {
    primarySourceLabel,
    sourceCount: Math.max(sourceLinks.length, 1),
    overlapSummary: decision
      ? `${decision.sourceCount} matched source records · ${decision.primarySourceLabel} selected by source priority`
      : null,
  };
}

function primarySourceLabelFor(
  providerId: string,
  subsource: string | null,
  sourceLinks: SourceLink[] | undefined,
  lookupProvider?: ProviderLookup,
): string {
  const matchingLink = sourceLinks?.find(
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
