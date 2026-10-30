import type {
  CatalogueCandidate,
  CatalogueLocation,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueContext,
} from "@dofek/training/climbing-catalogue";
import Fuse from "fuse.js";

type NameMatch = "exact" | "alias" | "approximate";
type Geography = "compatible" | "conflict" | "unknown";
type AttributedMatch = ClimbingCatalogueContext["sources"][number]["matches"][number] & {
  evidence: string[];
};

/** Normalize presentation, retaining directional, start, extension and pitch words. */
export function normalizeCatalogueName(value: string): string {
  const article = value.normalize("NFKC").replace(/^(.*),\s*(the|a|an)\s*$/iu, "$2 $1");
  return article
    .toLowerCase()
    .replace(/['’‘ʼ]/gu, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** Fuzzy results are discovery suggestions, never identity evidence. */
export function catalogueNameMatch(
  name: string,
  candidate: { name: string; aliases?: string[] },
): NameMatch | null {
  const needle = normalizeCatalogueName(name);
  if (!needle) return null;
  const names = [candidate.name, ...(candidate.aliases ?? [])].map(normalizeCatalogueName);
  if (needle === names[0]) return "exact";
  if (names.slice(1).includes(needle)) return "alias";
  const suggestions = new Fuse(names, { threshold: 0.25, ignoreLocation: true }).search(needle);
  return suggestions.length ? "approximate" : null;
}

/** Provider ancestry is root to leaf; route points never substitute for area evidence. */
export function catalogueLocalArea(locations: CatalogueLocation[]): CatalogueLocation | null {
  return locations.filter((location) => location.scope === "area").at(-1) ?? null;
}

function withinLocalArea(left: CatalogueLocation, right: CatalogueLocation): boolean {
  if (!left.coordinates || !right.coordinates) return false;
  const radians = Math.PI / 180;
  const origin = left.coordinates;
  const destination = right.coordinates;
  const haversine =
    Math.sin(((destination.latitude - origin.latitude) * radians) / 2) ** 2 +
    Math.cos(origin.latitude * radians) *
      Math.cos(destination.latitude * radians) *
      Math.sin(((destination.longitude - origin.longitude) * radians) / 2) ** 2;
  const metres = 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, haversine)));
  return metres <= 100;
}

function sameAreaName(left: CatalogueLocation, right: CatalogueLocation): boolean {
  const name = normalizeCatalogueName(left.name);
  return name.length > 0 && name === normalizeCatalogueName(right.name);
}

function geography(left: CatalogueLocation[], right: CatalogueLocation[]): Geography {
  const localLeft = catalogueLocalArea(left);
  const localRight = catalogueLocalArea(right);
  if (!localLeft || !localRight) return "unknown";
  // A shared broad ancestor cannot erase conflicting nearest-area observations.
  if (!localLeft.coordinates || !localRight.coordinates) return "unknown";
  if (!withinLocalArea(localLeft, localRight)) return "conflict";
  if (sameAreaName(localLeft, localRight)) return "compatible";
  // One source can include an extra local level. Align the other's nearest area,
  // rather than accepting an arbitrary shared country/park ancestor.
  const aligned = (locations: CatalogueLocation[], nearest: CatalogueLocation) =>
    locations.some(
      (location) =>
        location.scope === "area" &&
        sameAreaName(location, nearest) &&
        withinLocalArea(location, nearest),
    );
  return aligned(left, localRight) || aligned(right, localLeft) ? "compatible" : "conflict";
}

function nameEvidence(seed: CatalogueSeed, candidate: CatalogueCandidate): NameMatch | null {
  const primary = catalogueNameMatch(seed.name, candidate);
  if (primary === "exact" || primary === "alias") return primary;
  let approximate = primary;
  for (const alias of seed.aliases ?? []) {
    const match = catalogueNameMatch(alias, candidate);
    if (match === "exact" || match === "alias") return "alias";
    if (match === "approximate") approximate = match;
  }
  return approximate;
}

function explicitReference(seed: CatalogueSeed, candidate: CatalogueCandidate): boolean {
  const recorded = [
    ...(seed.externalId ? [{ providerId: seed.providerId, externalId: seed.externalId }] : []),
    ...(seed.references ?? []),
  ];
  const found = [candidate, ...(candidate.references ?? [])];
  return recorded.some((reference) =>
    found.some(
      (other) =>
        reference.providerId === other.providerId && reference.externalId === other.externalId,
    ),
  );
}

/** Attribute every decision; source observations are never rewritten or persisted here. */
export function matchCatalogueCandidates(
  seed: CatalogueSeed,
  found: CatalogueSearchResult,
): AttributedMatch[] {
  const candidates = [
    ...new Map(
      found.candidates.map((candidate) => [
        `${candidate.providerId}:${candidate.externalId}`,
        candidate,
      ]),
    ).values(),
  ];
  const assessed = candidates
    .map((candidate) => {
      const native =
        candidate.providerId === seed.providerId && candidate.externalId === seed.externalId;
      const reference = !native && explicitReference(seed, candidate);
      const name = nameEvidence(seed, candidate);
      const place = geography(seed.locations, candidate.locations);
      const conflicts: string[] = [];
      if (seed.kind && candidate.kind && seed.kind !== candidate.kind)
        conflicts.push("Known route/boulder kinds conflict.");
      if (seed.setting && candidate.setting && seed.setting !== candidate.setting)
        conflicts.push("Known indoor/outdoor settings conflict.");
      if (place === "conflict")
        conflicts.push(
          `Nearest local areas conflict: ${catalogueLocalArea(seed.locations)?.name} / ${catalogueLocalArea(candidate.locations)?.name}.`,
        );
      return { candidate, native, reference, name, place, conflicts };
    })
    .filter((match) => match.native || match.reference || match.name !== null);
  const plausible = assessed.filter((match) => match.conflicts.length === 0);
  const complete =
    found.complete &&
    (!found.searchArea ||
      (found.searchArea.scope === "area" &&
        geography(seed.locations, [found.searchArea]) === "compatible"));
  return assessed.map(({ candidate, native, reference, name, place, conflicts }) => {
    if (native)
      return {
        candidate,
        confidence: "source",
        evidence: ["Recorded source provider and ID match.", ...conflicts],
      };
    const evidence: string[] = [];
    if (reference) evidence.push("Explicit provider reference links these climbs.");
    if (name === "exact") evidence.push("Normalized climb names match.");
    if (name === "alias") evidence.push("A source-declared alias matches.");
    if (name === "approximate")
      evidence.push("Approximate name only; route qualifiers remain distinct.");
    evidence.push(...conflicts);
    if (place === "compatible")
      evidence.push(
        `Local areas align within 100 m: ${catalogueLocalArea(seed.locations)?.name} / ${catalogueLocalArea(candidate.locations)?.name}.`,
      );
    if (place === "unknown") evidence.push("Independent local-area geography is unavailable.");
    if (reference && conflicts.length === 0)
      return { candidate, confidence: "reference", evidence };
    const outdoor = seed.setting === "outdoor" || candidate.setting === "outdoor";
    const kind = seed.kind !== null && seed.kind === candidate.kind;
    if (!kind) evidence.push("Known matching route/boulder kinds are required.");
    if (!outdoor) evidence.push("Outdoor geography cannot verify indoor gym or set identity.");
    if (!complete) evidence.push("Discovery is incomplete for the matched local area.");
    if (plausible.length > 1)
      evidence.push("Another plausible local or unlocated candidate remains.");
    const corroborated =
      (name === "exact" || name === "alias") &&
      kind &&
      outdoor &&
      conflicts.length === 0 &&
      place === "compatible" &&
      complete &&
      plausible.length === 1;
    return { candidate, confidence: corroborated ? "corroborated" : "possible", evidence };
  });
}
