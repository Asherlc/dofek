import { z } from "zod";
import { activityMetricSourcePresentation } from "./activity-metric-source.ts";
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
