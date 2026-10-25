import {
  type ActivityHardware,
  type ActivityHardwareItem,
  activityHardwareRoleLabels,
} from "./activity-hardware.ts";
import type { ActivitySourceTree, ActivitySourceTreeNode } from "./activity-source-tree.ts";
import { providerLabel, providerLogoType, providerSourceLogo } from "./providers.ts";

function appendDetails(node: ActivitySourceTreeNode, details: { label: string; value: string }[]) {
  for (const detail of details) {
    if (
      node.details?.some(
        (existing) => existing.label === detail.label && existing.value === detail.value,
      )
    )
      continue;
    node.details ??= [];
    node.details.push({ ...detail });
  }
}

function hardwareDetails(item: ActivityHardwareItem, destinationLabel: string) {
  const model = item.model?.trim();
  const manufacturer = item.manufacturer?.trim();
  const label = destinationLabel.trim().toLowerCase();
  const details =
    model && !/^(?:apple\s+)?watch$/i.test(model) && model.toLowerCase() !== label
      ? [{ label: "Model", value: model }]
      : [];
  if (manufacturer && !label.includes(manufacturer.toLowerCase())) {
    details.push({ label: "Manufacturer", value: manufacturer });
  }
  return [...details, ...item.details];
}

export function activitySourceTreeWithHardware(
  tree: ActivitySourceTree,
  hardware: ActivityHardware,
): ActivitySourceTree {
  function cloneNode(node: ActivitySourceTreeNode): ActivitySourceTreeNode {
    return {
      ...node,
      ...(node.details ? { details: node.details.map((detail) => ({ ...detail })) } : {}),
      children: node.children.map(cloneNode),
    };
  }
  const result = {
    primary: tree.primary ? cloneNode(tree.primary) : null,
    otherSources: tree.otherSources.map(cloneNode),
  };
  const nodes = new Map<string, ActivitySourceTreeNode>();
  function index(node: ActivitySourceTreeNode) {
    nodes.set(node.id, node);
    node.children.forEach(index);
  }
  if (result.primary) index(result.primary);
  result.otherSources.forEach(index);

  function source(activityId: string, providerId: string) {
    const existing = nodes.get(activityId);
    if (existing) return existing;
    const node: ActivitySourceTreeNode = {
      id: activityId,
      providerId,
      sourceName: null,
      label: providerLabel(providerId),
      description: null,
      url: null,
      children: [],
    };
    nodes.set(node.id, node);
    result.otherSources.push(node);
    return node;
  }

  for (const item of hardware.items) {
    const parent = source(item.activityId, item.providerId);
    const attribution = nodes.get(`${item.activityId}:recording-attribution`);
    const recordingDevice =
      attribution && ["apple-watch", "garmin"].includes(attribution.providerId)
        ? attribution
        : parent.providerId === "garmin" && parent.sourceName
          ? parent
          : null;
    if (item.role === "recorder" && recordingDevice) {
      appendDetails(recordingDevice, hardwareDetails(item, recordingDevice.label));
      continue;
    }
    const existing = nodes.get(item.id);
    if (existing) {
      appendDetails(existing, hardwareDetails(item, existing.label));
      continue;
    }
    const logoCandidate = providerSourceLogo("apple_health", item.label).provider;
    const node: ActivitySourceTreeNode = {
      id: item.id,
      providerId: providerLogoType(logoCandidate) ? logoCandidate : item.providerId,
      sourceName: item.label,
      label: item.label,
      description: ["category", "recorder", "source"].includes(item.role)
        ? null
        : activityHardwareRoleLabels[item.role],
      url: null,
      children: [],
    };
    appendDetails(node, hardwareDetails(item, node.label));
    parent.children.push(node);
    nodes.set(node.id, node);
  }
  for (const power of hardware.power) {
    appendDetails(source(power.activityId, power.providerId), [
      { label: "Power", value: power.kind === "measured" ? "Measured" : "Estimated" },
    ]);
  }
  return result;
}
