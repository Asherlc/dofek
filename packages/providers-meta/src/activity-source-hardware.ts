import type { ActivityHardware } from "./activity-hardware.ts";
import type { ActivitySourceTree, ActivitySourceTreeNode } from "./activity-source-tree.ts";
import { deviceDisplayName } from "./device-names.ts";
import { providerFamily } from "./provider-catalog.ts";
import { providerLabel } from "./providers.ts";

/** Hardware can name a recording; only source-tree evidence establishes sharing. */
export function activitySourceTreeWithHardware(
  tree: ActivitySourceTree,
  hardware: ActivityHardware,
): ActivitySourceTree {
  const nodes = new Map<string, ActivitySourceTreeNode>();
  const roots = new Set<string>();
  function clone(node: ActivitySourceTreeNode): ActivitySourceTreeNode {
    const result = {
      ...node,
      label: deviceDisplayName(node.label),
      children: node.children.map(clone),
    };
    nodes.set(result.id, result);
    return result;
  }
  const result = {
    primary: tree.primary ? clone(tree.primary) : null,
    otherSources: tree.otherSources.map(clone),
  };
  if (result.primary) roots.add(result.primary.id);
  for (const node of result.otherSources) roots.add(node.id);
  for (const item of hardware.items) {
    let node = nodes.get(item.activityId);
    if (!node) {
      node = {
        id: item.activityId,
        providerId: item.providerId,
        sourceName: null,
        label: providerLabel(item.providerId),
        description: null,
        url: null,
        children: [],
      };
      nodes.set(node.id, node);
      roots.add(node.id);
      result.otherSources.push(node);
    }
    const genericLabel = [
      item.providerId,
      providerLabel(item.providerId),
      providerFamily(item.providerId)?.methodLabel,
    ].includes(node.label);
    const recordingLabel =
      (item.providerId === "garmin" && item.role === "recorder") ||
      (item.providerId === "peloton" &&
        item.role === "category" &&
        /^Peloton Bike/.test(item.label));
    if (roots.has(node.id) && genericLabel && recordingLabel) {
      node.label = deviceDisplayName(item.label);
      node.sourceName = item.sourceName ?? item.label;
    }
  }
  return result;
}
