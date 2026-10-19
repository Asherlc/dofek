import type { ClimbingSourceLink } from "./climbing-context.ts";

export function selectClimbingSources(
  sourceName: string | null,
  links: readonly ClimbingSourceLink[],
  providerLabel: (providerId: string) => string,
) {
  const primaryRoute = links.find((link) => link.kind === "route");
  const additionalRoutes = links.filter((link) => link.kind === "route" && link !== primaryRoute);
  const labels = [
    ...new Set([
      ...(sourceName
        ?.split(",")
        .map((source) => source.trim())
        .filter(Boolean) ?? []),
      ...links.map((link) => providerLabel(link.providerId)),
    ]),
  ];
  const sources = labels.map((label) => ({
    label,
    tickSource: links.find(
      (link) => link.kind === "ticks" && providerLabel(link.providerId) === label,
    ),
  }));
  return { primaryRoute, additionalRoutes, sources };
}
