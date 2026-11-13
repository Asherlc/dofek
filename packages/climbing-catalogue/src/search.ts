import {
  type CatalogueProviderId,
  type CatalogueSearchResult,
  type CatalogueSeed,
  type CatalogueSourceResult,
  type ClimbingCatalogueAdapter,
  catalogueSearchResultSchema,
  catalogueSeedSchema,
} from "./contracts.ts";
import { matchCatalogueCandidates } from "./matching.ts";

/** Failed sources stay observable while callers retain the sources that succeeded. */
export class CatalogueSearchError extends AggregateError {
  readonly sources: CatalogueSourceResult[];

  constructor(
    failures: { providerId: CatalogueProviderId; error: unknown }[],
    sources: CatalogueSourceResult[],
  ) {
    super(
      failures.map(({ error }) => error),
      failures
        .map(
          ({ providerId, error }) =>
            `${providerId}: ${error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "Catalogue lookup failed. Try refreshing again."}`,
        )
        .join("\n"),
    );
    this.name = "CatalogueSearchError";
    this.sources = sources;
  }
}

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
    const [nativeOutcome] = await Promise.allSettled(
      nativeAdapter ? [search(nativeAdapter, seed)] : [],
    );
    const nativeFound = nativeOutcome?.status === "fulfilled" ? nativeOutcome.value : undefined;
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
          locations: native.locations.some((location) => location.scope === "area")
            ? native.locations
            : seed.locations,
        }
      : seed;
    const outcomes = await Promise.allSettled(
      this.#adapters.map(async (adapter) => {
        if (adapter === nativeAdapter && nativeOutcome?.status === "rejected")
          throw nativeOutcome.reason;
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
    const sources: CatalogueSourceResult[] = [];
    const failures: { providerId: CatalogueProviderId; error: unknown }[] = [];
    for (const [index, adapter] of this.#adapters.entries()) {
      const outcome = outcomes[index];
      if (outcome?.status === "fulfilled") sources.push(outcome.value);
      else if (outcome?.status === "rejected")
        failures.push({ providerId: adapter.providerId, error: outcome.reason });
    }
    if (failures.length) throw new CatalogueSearchError(failures, sources);
    return sources;
  }
}
