import { createHash } from "node:crypto";
import { ClimbingCatalogueSearch } from "@dofek/climbing-catalogue";
import type { ClimbingCatalogueAdapter } from "@dofek/climbing-catalogue/contracts";
import {
  type CatalogueSeed,
  type ClimbingCatalogueContext,
  catalogueSeedSchema,
  climbingCatalogueContextSchema,
} from "@dofek/training/climbing-catalogue";
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

export function catalogueSeedCacheKey(seed: CatalogueSeed): string {
  const { logEntryId: _logEntryId, ...source } = catalogueSeedSchema.parse(seed);
  const fingerprint = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  return `${seed.userId}:climbing.catalogueContext:v4:${fingerprint}`;
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
    const cached = await this.cache.get(catalogueSeedCacheKey(seed));
    if (cached === undefined) return { ...missing, sources: [] };
    const result = climbingCatalogueContextSchema.parse(cached);
    return result.expiresAt && Date.parse(result.expiresAt) <= Date.now()
      ? { ...missing, sources: [] }
      : result;
  }

  async invalidate(seed: CatalogueSeed): Promise<void> {
    await this.cache.invalidate(catalogueSeedCacheKey(seed));
  }

  async markFailed(seed: CatalogueSeed, error: unknown): Promise<void> {
    captureException(error, { tags: { phase: "climbing-catalogue-refresh" } });
    const previous = await this.read(seed);
    const expiresAt =
      previous.fetchedAt && previous.expiresAt
        ? previous.expiresAt
        : new Date(Date.now() + DAY).toISOString();
    await this.cache.set(
      catalogueSeedCacheKey(seed),
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
      const { userId: _userId, logEntryId: _logEntryId, ...query } = seed;
      const sources = await new ClimbingCatalogueSearch(this.adapters).search(query);
      const ttl = sources.some((source) => source.matches.length > 0) ? 7 * DAY : DAY;
      const result = climbingCatalogueContextSchema.parse({
        status: "ready",
        sources,
        error: null,
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      });
      await this.cache.set(catalogueSeedCacheKey(seed), result, ttl);
      return result;
    } catch (error) {
      await this.markFailed(seed, error);
      throw error;
    }
  }
}
