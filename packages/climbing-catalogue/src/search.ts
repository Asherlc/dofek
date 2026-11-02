import {
  type CatalogueSearchResult,
  type CatalogueSeed,
  type CatalogueSourceResult,
  type ClimbingCatalogueAdapter,
  catalogueSearchResultSchema,
  catalogueSeedSchema,
} from "./contracts.ts";
import { matchCatalogueCandidates } from "./matching.ts";

async function search(
  adapter: ClimbingCatalogueAdapter,
  seed: CatalogueSeed,
): Promise<CatalogueSearchResult> {
  const found = catalogueSearchResultSchema.parse(await adapter.search(seed));
  if (found.candidates.some((candidate) => candidate.providerId !== adapter.providerId))
    throw new Error(`Unexpected provider in ${adapter.providerId} catalogue response.`);
  return found;
}

/** Native-first cross-provider discovery; never mutates or persists the recorded seed. */
export class ClimbingCatalogueSearch {
  readonly #adapters: readonly ClimbingCatalogueAdapter[];
  constructor(adapters: readonly ClimbingCatalogueAdapter[]) {
    this.#adapters = [...adapters];
  }
  async search(input: CatalogueSeed): Promise<CatalogueSourceResult[]> {
    const seed = catalogueSeedSchema.parse(input);
    const nativeAdapter = seed.externalId
      ? this.#adapters.find((adapter) => adapter.providerId === seed.providerId)
      : undefined;
    const nativeFound = nativeAdapter ? await search(nativeAdapter, seed) : undefined;
    const native = nativeFound?.candidates
      .filter((candidate) => candidate.externalId === seed.externalId)
      .at(-1);
    // Enrichment is local to this lookup; recorded facts remain unchanged.
    const discoverySeed: CatalogueSeed = native
      ? {
          ...seed,
          name: native.name,
          aliases: [
            ...new Set([
              ...(seed.name ? [seed.name] : []),
              ...(seed.aliases ?? []),
              ...(native.aliases ?? []),
            ]),
          ],
          references: [
            ...new Map(
              [...(seed.references ?? []), ...(native.references ?? [])].map((reference) => [
                `${reference.providerId}:${reference.externalId}`,
                reference,
              ]),
            ).values(),
          ],
          kind: seed.kind ?? native.kind,
          setting: seed.setting ?? native.setting,
          locations: native.locations.length ? native.locations : seed.locations,
        }
      : seed;
    const sources = await Promise.all(
      this.#adapters.map(async (adapter) => {
        const found =
          adapter === nativeAdapter && nativeFound
            ? nativeFound
            : await search(adapter, discoverySeed);
        return {
          providerId: adapter.providerId,
          searchComplete: found.complete,
          ...(found.searchArea ? { searchArea: found.searchArea } : {}),
          matches: matchCatalogueCandidates(discoverySeed, found, seed.locations),
        };
      }),
    );

    return sources;
  }
}
