import { createHash } from "node:crypto";
import { CatalogueSearchError, ClimbingCatalogueSearch } from "@dofek/climbing-catalogue";
import type { ClimbingCatalogueAdapter } from "@dofek/climbing-catalogue/contracts";
import { KayaCatalogueUnavailableError } from "@dofek/climbing-catalogue/kaya";
import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import {
  type CatalogueSeed,
  type ClimbingCatalogueContext,
  catalogueSeedSchema,
  climbingCatalogueContextSchema,
} from "@dofek/training/climbing-catalogue";
import type { CacheStore } from "./lib/cache.ts";
import { captureException } from "./lib/error-reporting.ts";
import { isKnownProviderHttp5xxError } from "./lib/provider-error-reporting.ts";
import { findProviderTransportError } from "./lib/provider-transport-error.ts";
import { logger } from "./logger.ts";

const DAY = 86_400_000;
const missing: ClimbingCatalogueContext = {
  status: "missing",
  fetchedAt: null,
  expiresAt: null,
  error: null,
  sources: [],
};

function isCatalogueProviderOutage(error: unknown): boolean {
  return error instanceof KayaCatalogueUnavailableError || isKnownProviderHttp5xxError(error);
}

export function isRetryableCatalogueSearchError(error: unknown): boolean {
  return (
    error instanceof CatalogueSearchError &&
    error.errors.length > 0 &&
    error.errors.every(isCatalogueProviderOutage)
  );
}

export function catalogueSeedCacheKey(seed: CatalogueSeed): string {
  const { logEntryId: _logEntryId, ...source } = catalogueSeedSchema.parse(seed);
  const fingerprint = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  return `${seed.userId}:climbing.catalogueContext:v6:${fingerprint}`;
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
    const failures: unknown[] = error instanceof CatalogueSearchError ? error.errors : [error];
    const providerFailures = failures
      .map((failure) => {
        if (failure instanceof KayaCatalogueUnavailableError)
          return { providerId: "kaya", graphqlCode: "INTERNAL_SERVER_ERROR" };
        const httpFailure =
          failure instanceof ProviderRateLimitError ? failure : findProviderTransportError(failure);
        if (
          !(httpFailure instanceof ProviderRateLimitError) &&
          !(httpFailure instanceof ProviderServiceUnavailableError)
        )
          return null;
        return {
          providerId: httpFailure.providerId,
          statusCode: httpFailure.statusCode,
          scope: httpFailure.scope,
          retryAfterSeconds: httpFailure.retryAfterSeconds,
          responseBodyBytes: Buffer.byteLength(httpFailure.responseBody, "utf8"),
        };
      })
      .filter((failure) => failure !== null);
    const reportable = failures.filter((failure) => !isCatalogueProviderOutage(failure));
    if (reportable.length < failures.length) {
      logger.warn("[climbing-catalogue] Upstream service unavailable: %j", providerFailures);
    }
    if (reportable.length > 0) {
      const exception =
        reportable.length === failures.length
          ? error
          : new AggregateError(reportable, "Unexpected climbing catalogue provider failure");
      captureException(exception, {
        tags: { phase: "climbing-catalogue-refresh" },
        ...(providerFailures.length > 0 ? { extra: { providerFailures } } : {}),
      });
    }
    const previous = await this.read(seed);
    const partialSources = error instanceof CatalogueSearchError ? error.sources : [];
    const sourcesByProvider = new Map(
      [...previous.sources, ...partialSources].map((source) => [source.providerId, source]),
    );
    const expiresAt =
      partialSources.length === 0 && previous.fetchedAt && previous.expiresAt
        ? previous.expiresAt
        : new Date(Date.now() + DAY).toISOString();
    await this.cache.set(
      catalogueSeedCacheKey(seed),
      {
        ...previous,
        sources: [...sourcesByProvider.values()],
        ...(partialSources.length > 0 ? { fetchedAt: new Date().toISOString() } : {}),
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
