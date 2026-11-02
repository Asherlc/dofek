import { z } from "zod";
import {
  type ActivityMetricSource,
  activityMetricSourcePresentation,
} from "./activity-metric-source.ts";
import { providerFamily } from "./provider-catalog.ts";
import { providerLabel } from "./providers.ts";

export function activitySourceNodePresentation(node: ActivitySourceTreeNode) {
  const family = providerFamily(node.providerId);
  return family &&
    ["Cloud", "Bluetooth"].includes(family.methodLabel) &&
    node.label === providerLabel(node.providerId)
    ? activityMetricSourcePresentation(node.providerId, node.sourceName, node.label)
    : { displayName: node.label, attribution: null };
}

export interface ActivitySourceTreeNode {
  id: string;
  providerId: string;
  sourceName: string | null;
  label: string;
  description: string | null;
  url: string | null;
  details?: { label: string; value: string }[];
  children: ActivitySourceTreeNode[];
}

export const activitySourceTreeNodeSchema: z.ZodType<ActivitySourceTreeNode> = z.object({
  id: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  children: z.lazy(() => z.array(activitySourceTreeNodeSchema)),
});

export const activitySourceTreeSchema = z.object({
  primary: activitySourceTreeNodeSchema.nullable(),
  otherSources: z.array(activitySourceTreeNodeSchema),
});

export type ActivitySourceTree = z.infer<typeof activitySourceTreeSchema>;

/** Project proven ancestry from the canonical disclosure tree, never infer new edges. */
export function activityMetricSourceInheritance(
  tree: ActivitySourceTree,
  memberActivityIds: string[],
  deliveryProviderId: string,
): Pick<ActivityMetricSource, "label" | "presentation"> | null {
  function findPath(nodes: ActivitySourceTreeNode[], id: string): ActivitySourceTreeNode[] | null {
    for (const node of nodes) {
      if (node.id === id) return [node];
      const path = findPath(node.children, id);
      if (path) return [node, ...path];
    }
    return null;
  }
  const roots = tree.primary ? [tree.primary, ...tree.otherSources] : tree.otherSources;
  const paths = memberActivityIds.map((id) => findPath(roots, id));
  const path = paths[0];
  const normalizeProviderId = (id: string | undefined) =>
    id === "apple-health" ? "apple_health" : id;
  if (
    !path ||
    path.length < 2 ||
    paths.some(
      (candidate) =>
        !candidate ||
        candidate.length !== path.length ||
        candidate.slice(0, -1).some((node, index) => node.id !== path[index]?.id) ||
        normalizeProviderId(candidate.at(-1)?.providerId) !==
          normalizeProviderId(deliveryProviderId),
    )
  )
    return null;
  const origin = path[0];
  const delivery = path[path.length - 1];
  if (
    !origin ||
    !delivery ||
    normalizeProviderId(origin.providerId) === normalizeProviderId(delivery.providerId)
  )
    return null;
  const original = activityMetricSourcePresentation(
    origin.providerId,
    origin.sourceName,
    origin.label,
    origin.label,
  );
  const providers = path.slice(1).map((node) => providerLabel(node.providerId));
  return {
    label: `${original.displayName} via ${providers.join(" → ")}`,
    presentation: {
      ...original,
      attribution:
        delivery.providerId === "apple_health" || delivery.providerId === "apple-health"
          ? { kind: "apple_health", label: "Apple Health" }
          : {
              kind: "provider",
              providerId: delivery.providerId,
              label: providerLabel(delivery.providerId),
            },
    },
  };
}
