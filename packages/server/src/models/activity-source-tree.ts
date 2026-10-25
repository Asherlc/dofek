import type { ActivityOrigin, ActivityOriginEvidence } from "@dofek/providers/activity-origin";
import { activitySourceDetails } from "@dofek/providers/activity-source-details";
import type {
  ActivitySourceTree,
  ActivitySourceTreeNode,
} from "@dofek/providers/activity-source-tree";
import { providerLabel } from "@dofek/providers/providers";
import type { SourceLink } from "./activity-source-attribution.ts";

/** Held-copy ancestry comes only from explicit member-to-member origin evidence. */
export function buildActivitySourceTree(
  origin: ActivityOrigin,
  sourceLinks: SourceLink[],
  evidence: ActivityOriginEvidence[],
): ActivitySourceTree {
  const links = [...sourceLinks].sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      (left.memberActivityId ?? left.externalId).localeCompare(
        right.memberActivityId ?? right.externalId,
      ),
  );
  const sources = new Map(
    links.map((link) => [
      link.memberActivityId ?? `${link.providerId}:${link.externalId}:${link.subsource ?? ""}`,
      link,
    ]),
  );
  const parents = new Map<string, Set<string>>();
  for (const edge of evidence) {
    const upstream = edge.upstreamMemberActivityId;
    const downstream = edge.downstreamMemberActivityId;
    if (!sources.has(upstream) || !sources.has(downstream)) continue;
    const candidates = parents.get(downstream) ?? new Set<string>();
    candidates.add(upstream);
    parents.set(downstream, candidates);
  }
  // Inspect all evidence before pruning ambiguity: removing one inbound edge
  // first can conceal a cycle and leave its remaining edge looking valid.
  const cyclic = new Set<string>();
  for (const id of sources.keys()) {
    const pending = [...(parents.get(id) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      if (current === id) {
        cyclic.add(id);
        break;
      }
      visited.add(current);
      pending.push(...(parents.get(current) ?? []));
    }
  }
  // Multiple parents cannot be represented as a tree without choosing an unproven path.
  const parentById = new Map<string, string>();
  for (const [id, candidates] of parents) {
    if (candidates.size === 1 && !cyclic.has(id)) {
      const parent = candidates.values().next().value;
      if (parent !== undefined) parentById.set(id, parent);
    }
  }

  const primaryId =
    origin.status === "resolved" && !cyclic.has(origin.memberActivityId)
      ? origin.memberActivityId
      : null;
  function project(id: string, source: SourceLink): ActivitySourceTreeNode {
    const parentId = parentById.get(id);
    const parent = parentId ? sources.get(parentId) : undefined;
    const relationship = parent
      ? `Imported from ${providerLabel(parent.providerId)}`
      : id === primaryId
        ? "Closest available recording"
        : "Other matching source";
    const node: ActivitySourceTreeNode = {
      id,
      providerId: source.providerId,
      label: providerLabel(source.providerId),
      description: `${relationship}${source.providerAbsentAt ? " · Removed from provider" : ""}`,
      url: source.url,
      children: [...sources]
        .filter(([child]) => parentById.get(child) === id)
        .map(([child, link]) => project(child, link)),
    };
    if (parent || cyclic.has(id)) return node;
    const attribution = activitySourceDetails({
      status: "resolved",
      memberActivityId: id,
      providerId: source.providerId,
      sourceName:
        source.subsource ??
        (origin.status === "resolved" && id === primaryId ? origin.sourceName : null),
    });
    if (!attribution?.importedVia) return node;
    node.description = `Recording attribution reported by ${providerLabel(source.providerId)}${source.providerAbsentAt ? " · Removed from provider" : ""}`;
    return {
      id: `${id}:recording-attribution`,
      providerId: attribution.recordingApp.provider,
      label: attribution.recordingApp.label,
      description: "Recording app or device attribution",
      url: null,
      children: [node],
    };
  }
  let primaryRoot = primaryId;
  while (primaryRoot !== null && parentById.has(primaryRoot)) {
    primaryRoot = parentById.get(primaryRoot) ?? null;
  }
  if (primaryRoot !== null && cyclic.has(primaryRoot)) primaryRoot = null;
  let primary: ActivitySourceTreeNode | null = null;
  const otherSources: ActivitySourceTreeNode[] = [];
  for (const [id, source] of sources) {
    if (parentById.has(id)) continue;
    const node = project(id, source);
    if (id === primaryRoot) primary = node;
    else otherSources.push(node);
  }
  return { primary, otherSources };
}
