import { z } from "zod";
import type { ActivitySourceTree, ActivitySourceTreeNode } from "./activity-source-tree.ts";
import { deviceDisplayName } from "./device-names.ts";
import { providerCatalogEntry, providerFamily } from "./provider-catalog.ts";
import { providerLabel, providerLogoType, providerSourceLogo } from "./providers.ts";

export const activityMetricSourcePresentationSchema = z.object({
  displayName: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  attribution: z
    .union([
      z.object({
        kind: z.enum(["apple_health", "cloud", "bluetooth"]),
        label: z.string(),
      }),
      z.object({ kind: z.literal("provider"), providerId: z.string(), label: z.string() }),
    ])
    .nullable(),
});
export type ActivityMetricSourcePresentation = z.infer<
  typeof activityMetricSourcePresentationSchema
>;

export const activityMetricSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  presentation: activityMetricSourcePresentationSchema,
});
export type ActivityMetricSource = z.infer<typeof activityMetricSourceSchema>;

/** Project proven ancestry from the canonical disclosure tree, never infer new edges. */
export function activityMetricSourceInheritance(
  tree: ActivitySourceTree,
  memberActivityIds: string[],
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
  if (
    !path ||
    path.length < 2 ||
    paths.some(
      (candidate) =>
        !candidate ||
        candidate.length !== path.length ||
        candidate.some((node, index) => node.id !== path[index]?.id),
    )
  )
    return null;
  const origin = path[0];
  const delivery = path[path.length - 1];
  if (!origin || !delivery || origin.providerId === delivery.providerId) return null;
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

/** Visible text beside the logo, retaining names that distinguish devices or unknown sources. */
export function activityMetricSourceText(
  presentation: ActivityMetricSourcePresentation,
): string | null {
  const { provider } = providerSourceLogo(presentation.providerId, presentation.sourceName);
  const name = presentation.displayName.trim().toLowerCase();
  const redundant =
    name === providerLabel(provider).toLowerCase() ||
    name === providerFamily(provider)?.label.toLowerCase();
  return providerLogoType(provider) && redundant ? null : presentation.displayName;
}

export function activityMetricSourcePresentation(
  providerId: string,
  sourceName: string | null,
  fullLabel: string,
  hardwareName?: string,
): ActivityMetricSourcePresentation {
  if (providerId === "apple_health" || providerId === "apple-health") {
    const { viaAppleHealth } = providerSourceLogo(providerId, sourceName);
    return {
      displayName: viaAppleHealth
        ? deviceDisplayName(sourceName ?? "Apple Health")
        : "Apple Health",
      providerId,
      sourceName,
      attribution: viaAppleHealth ? { kind: "apple_health", label: "Apple Health" } : null,
    };
  }
  const family = providerFamily(providerId);
  if (family && (family.methodLabel === "Cloud" || family.methodLabel === "Bluetooth")) {
    return {
      displayName: family.label,
      providerId,
      sourceName,
      attribution: {
        kind: family.methodLabel === "Cloud" ? "cloud" : "bluetooth",
        label: family.methodLabel,
      },
    };
  }
  if (providerId === "ble_heart_rate") {
    return {
      displayName: sourceName ? deviceDisplayName(sourceName) : "Heart Rate Monitor",
      providerId,
      sourceName,
      attribution: { kind: "bluetooth", label: "Bluetooth" },
    };
  }
  const name = hardwareName?.trim() || sourceName?.trim();
  const displayName = providerCatalogEntry(providerId)
    ? name
      ? deviceDisplayName(name)
      : providerLabel(providerId)
    : fullLabel;
  return { displayName, providerId, sourceName, attribution: null };
}
