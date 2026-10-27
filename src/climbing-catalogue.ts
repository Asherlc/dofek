import { createHash } from "node:crypto";
import {
  type CatalogueCandidate,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  type ClimbingCatalogueContext,
  catalogueSearchResultSchema,
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
const normalized = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

function key(seed: CatalogueSeed): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(catalogueSeedSchema.parse(seed)))
    .digest("hex");
  return `${seed.userId}:climbing.catalogueContext:v1:${fingerprint}`;
}
function corroborates(seed: CatalogueSeed, candidate: CatalogueCandidate): boolean {
  if (
    seed.setting !== "outdoor" ||
    candidate.setting !== "outdoor" ||
    !seed.kind ||
    seed.kind !== candidate.kind
  )
    return false;
  return seed.locations.some((location) =>
    candidate.locations.some(
      (other) =>
        location.scope === other.scope &&
        normalized(location.name) === normalized(other.name) &&
        location.coordinates !== null &&
        other.coordinates !== null &&
        Math.abs(location.coordinates.latitude - other.coordinates.latitude) <= 0.001 &&
        Math.abs(location.coordinates.longitude - other.coordinates.longitude) <= 0.001,
    ),
  );
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

  async markPending(seed: CatalogueSeed): Promise<ClimbingCatalogueContext> {
    const previous = await this.read(seed);
    const expiresAt = previous.expiresAt ?? new Date(Date.now() + 120_000).toISOString();
    const result: ClimbingCatalogueContext = {
      ...previous,
      status: "pending",
      error: null,
      expiresAt,
    };
    await this.cache.set(key(seed), result, Date.parse(expiresAt) - Date.now());
    return result;
  }

  async refresh(seed: CatalogueSeed): Promise<ClimbingCatalogueContext> {
    const previous = await this.read(seed);
    try {
      const sources = await Promise.all(
        this.adapters.map(async (adapter) => {
          const found = catalogueSearchResultSchema.parse(await adapter.search(seed));
          if (found.candidates.some((candidate) => candidate.providerId !== adapter.providerId)) {
            throw new Error(`Unexpected provider in ${adapter.providerId} catalogue response.`);
          }
          const candidates = [
            ...new Map(
              found.candidates
                .filter((candidate) => normalized(candidate.name) === normalized(seed.name))
                .map((candidate) => [candidate.externalId, candidate]),
            ).values(),
          ];
          return {
            providerId: adapter.providerId,
            searchComplete: found.complete,
            matches: candidates.map((candidate) => ({
              candidate,
              confidence:
                candidate.providerId === seed.providerId && candidate.externalId === seed.externalId
                  ? ("source" as const)
                  : found.complete && candidates.length === 1 && corroborates(seed, candidate)
                    ? ("corroborated" as const)
                    : ("possible" as const),
            })),
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
      captureException(error, { tags: { phase: "climbing-catalogue-refresh" } });
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
            error instanceof Error
              ? error.message
              : "Catalogue lookup failed. Try refreshing again.",
        },
        Math.max(1, Date.parse(expiresAt) - Date.now()),
      );
      throw error;
    }
  }
}
