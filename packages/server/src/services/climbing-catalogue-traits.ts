import type { CatalogueCandidate, CatalogueLocation } from "@dofek/climbing-catalogue/contracts";
import {
  catalogueAreasAreNearby,
  catalogueLocalArea,
  normalizeCatalogueName,
} from "@dofek/climbing-catalogue/matching";
import type { CatalogueSeed, ClimbingCatalogueContext } from "@dofek/training/climbing-catalogue";
import type { ClimbingTraitSource } from "@dofek/training/climbing-strengths";

export interface ClimbingCatalogueTrait {
  dimension: "wall_angle" | "hold_type" | "style";
  value: string;
  source: Omit<ClimbingTraitSource, "trait">;
}
const holds: Record<string, string> = {
  crimp: "crimp",
  crimps: "crimp",
  crimpy: "crimp",
  sloper: "sloper",
  slopers: "sloper",
  slopey: "sloper",
  pinch: "pinch",
  pinches: "pinch",
  jug: "jug",
  jugs: "jug",
  juggy: "jug",
  pocket: "pocket",
  pockets: "pocket",
  jam: "jam",
  jams: "jam",
  crack: "jam",
  tufa: "tufa",
  tufas: "tufa",
  edge: "edge",
  edges: "edge",
};
const walls: Record<string, string> = {
  slab: "slab",
  ramp: "slab",
  "ramp slab": "slab",
  vertical: "vertical",
  overhang: "overhang",
  overhung: "overhang",
  overhanging: "overhang",
  roof: "roof",
};
const styles = new Set([
  "technical",
  "athletic",
  "powerful",
  "cruxy",
  "sustained",
  "endurance",
  "balance",
  "dynamic",
]);
function mappedTag(
  tag: CatalogueCandidate["tags"][number],
): Pick<ClimbingCatalogueTrait, "dimension" | "value"> | null {
  const label = normalizeCatalogueName(tag.label);
  const wall =
    tag.kind === "steepness" ? (walls[tag.category ?? ""] ?? walls[label]) : walls[label];
  if (wall) return { dimension: "wall_angle", value: wall };
  const hold = holds[label];
  if (hold) return { dimension: "hold_type", value: hold };
  return styles.has(label) ? { dimension: "style", value: label } : null;
}
function ownsArea(
  seed: CatalogueSeed,
  candidate: CatalogueCandidate,
  location: CatalogueLocation,
): boolean {
  const recorded = catalogueLocalArea(seed.locations);
  if (!recorded || location.scope !== "area") return false;
  if (seed.providerId === candidate.providerId && recorded.externalId && location.externalId)
    return recorded.externalId === location.externalId;
  return (
    !!recorded.name &&
    !!location.name &&
    normalizeCatalogueName(recorded.name) === normalizeCatalogueName(location.name) &&
    catalogueAreasAreNearby(recorded, location)
  );
}

/** Explicit catalogue tags only. Source descriptions and aggregate counts are never route measurements. */
export function catalogueStrengthTraits(
  seed: CatalogueSeed,
  context: ClimbingCatalogueContext,
): ClimbingCatalogueTrait[] {
  const traits = new Map<string, ClimbingCatalogueTrait>();
  const add = (trait: ClimbingCatalogueTrait) => traits.set(JSON.stringify(trait), trait);
  for (const source of context.sources)
    for (const match of source.matches) {
      const { candidate } = match;
      const compatible =
        (!seed.kind || !candidate.kind || seed.kind === candidate.kind) &&
        (!seed.setting || !candidate.setting || seed.setting === candidate.setting);
      const routeIdentified =
        match.confidence !== "possible" &&
        compatible &&
        !(match.evidence ?? []).some((e) => /conflict/i.test(e));
      const routeSource = {
        providerId: candidate.providerId,
        name: candidate.name ?? seed.name ?? "Unnamed climb",
        url: candidate.url,
        scope: "route" as const,
      };
      if (routeIdentified) {
        if (candidate.angle?.unit === "degrees")
          add({ dimension: "wall_angle", value: `${candidate.angle.value}°`, source: routeSource });
        for (const tag of candidate.tags) {
          const mapped = mappedTag(tag);
          if (!mapped) continue;
          if (tag.scope === "direct") add({ ...mapped, source: routeSource });
          else {
            const parent = candidate.locations.find(
              (l) =>
                l.name &&
                tag.inheritedFrom &&
                normalizeCatalogueName(l.name) === normalizeCatalogueName(tag.inheritedFrom),
            );
            add({
              ...mapped,
              source: {
                ...routeSource,
                scope: "area",
                name: tag.inheritedFrom ?? "Parent area",
                url: parent?.context?.url ?? candidate.url,
              },
            });
          }
        }
      }
      for (const location of candidate.locations) {
        if (
          !location.context ||
          !location.name ||
          (!routeIdentified && !ownsArea(seed, candidate, location))
        )
          continue;
        for (const tag of location.context.tags) {
          const mapped = mappedTag(tag);
          if (mapped)
            add({
              ...mapped,
              source: {
                providerId: candidate.providerId,
                name: tag.inheritedFrom ?? location.name,
                url: location.context.url,
                scope: "area",
              },
            });
        }
      }
    }
  return [...traits.values()];
}
