import { createHash } from "node:crypto";
import {
  type CatalogueSearchResult,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  type ClimbingCatalogueContext,
  catalogueSearchResultSchema,
  catalogueSeedSchema,
  climbingCatalogueContextSchema,
} from "@dofek/training/climbing-catalogue";
import { matchCatalogueCandidates } from "./climbing-catalogue-matching.ts";
import type { CacheStore } from "./lib/cache.ts";
import { captureException } from "./lib/error-reporting.ts";

const DAY = 86_400_000;
const missing: ClimbingCatalogueContext = {
  status: "missing",
  fetchedAt: null,
  expiresAt: null,
  error: null,
  sources: [],
};

function key(seed: CatalogueSeed): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(catalogueSeedSchema.parse(seed)))
    .digest("hex");
  return `${seed.userId}:climbing.catalogueContext:v2:${fingerprint}`;
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

/** Disposable source context. It never writes facts, matches, or winners to the database. */
export class ClimbingCatalogueService {
  readonly cache: CacheStore;
  readonly adapters: readonly ClimbingCatalogueAdapter[];
  constructor(cache: CacheStore, adapters: readonly ClimbingCatalogueAdapter[]) {
    this.cache = cache;
    this.adapters = adapters;
  }

  async read(seed: CatalogueSeed): Promise<ClimbingCatalogueContext> {
    const cached = await this.cache.get(key(seed));
    if (cached === undefined) return { ...missing, sources: [] };
    const result = climbingCatalogueContextSchema.parse(cached);
    return result.expiresAt && Date.parse(result.expiresAt) <= Date.now()
      ? { ...missing, sources: [] }
      : result;
  }

  async invalidate(seed: CatalogueSeed): Promise<void> {
    await this.cache.invalidate(key(seed));
  }

  async markFailed(seed: CatalogueSeed, error: unknown): Promise<void> {
    captureException(error, { tags: { phase: "climbing-catalogue-refresh" } });
    const previous = await this.read(seed);
    const expiresAt =
      previous.fetchedAt && previous.expiresAt
        ? previous.expiresAt
        : new Date(Date.now() + DAY).toISOString();
    await this.cache.set(
      key(seed),
      {
        ...previous,
        status: "error",
        expiresAt,
        error:
          error instanceof Error ? error.message : "Catalogue lookup failed. Try refreshing again.",
      },
      Math.max(1, Date.parse(expiresAt) - Date.now()),
    );
  }

  async refresh(seed: CatalogueSeed): Promise<ClimbingCatalogueContext> {
    try {
      const nativeAdapter = seed.externalId
        ? this.adapters.find((adapter) => adapter.providerId === seed.providerId)
        : undefined;
      const nativeFound = nativeAdapter ? await search(nativeAdapter, seed) : undefined;
      const native = nativeFound?.candidates
        .filter((candidate) => candidate.externalId === seed.externalId)
        .at(-1);
      // This context exists only for this lookup. The logged seed still owns the cache key.
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
        this.adapters.map(async (adapter) => {
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
      const ttl = sources.some((source) => source.matches.length > 0) ? 7 * DAY : DAY;
      const result = climbingCatalogueContextSchema.parse({
        status: "ready",
        sources,
        error: null,
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      });
      await this.cache.set(key(seed), result, ttl);
      return result;
    } catch (error) {
      await this.markFailed(seed, error);
      throw error;
    }
  }
}
