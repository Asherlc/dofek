import type { ActivityOrigin, ActivityOriginEvidence } from "@dofek/providers/activity-origin";
import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";
import { providerLabel } from "@dofek/providers/providers";
import type { ProviderLookup, SourceLink } from "./activity-source-attribution.ts";
import { buildActivitySourceTree } from "./activity-source-tree.ts";

export interface ActivitySourceDecisionDetail {
  origin: ActivityOrigin;
  sourceCount: number;
  primarySourceLabel: string | null;
  explanation: string;
}

export interface ActivityListSourceDetail {
  origin: ActivityOrigin;
  primarySourceLabel: string | null;
  sourceCount: number;
  overlapSummary: string | null;
  tree: ActivitySourceTree;
}

function primaryLabel(origin: ActivityOrigin, lookupProvider?: ProviderLookup): string | null {
  return origin.status === "resolved"
    ? (lookupProvider?.(origin.providerId)?.name ?? providerLabel(origin.providerId))
    : null;
}

export function buildActivitySourceDecision(
  origin: ActivityOrigin,
  sourceLinks: SourceLink[],
  lookupProvider?: ProviderLookup,
): ActivitySourceDecisionDetail | null {
  if (sourceLinks.length < 2) return null;
  const primarySourceLabel = primaryLabel(origin, lookupProvider);
  return {
    origin,
    sourceCount: sourceLinks.length,
    primarySourceLabel,
    explanation:
      primarySourceLabel === null
        ? "The available source information does not establish which record is closest to the original recording."
        : `${primarySourceLabel} is the closest available record to the original recording. Individual details may come from other matched sources.`,
  };
}

export function buildActivityListSource(
  origin: ActivityOrigin,
  sourceLinks: SourceLink[] | undefined,
  lookupProvider: ProviderLookup | undefined,
  evidence: ActivityOriginEvidence[],
): ActivityListSourceDetail {
  const sourceCount = Math.max(sourceLinks?.length ?? 0, 1);
  return {
    origin,
    primarySourceLabel: primaryLabel(origin, lookupProvider),
    sourceCount,
    overlapSummary: sourceCount > 1 ? `${sourceCount} matched source records` : null,
    tree: buildActivitySourceTree(origin, sourceLinks ?? [], evidence),
  };
}
