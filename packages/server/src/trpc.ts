import { initTRPC, TRPCError } from "@trpc/server";
import { middlewareMarker } from "@trpc/server/unstable-core-do-not-import";
import type { Database } from "dofek/db";
import { queryCache } from "./lib/cache.ts";
import {
  cacheHitsTotal,
  cacheMissesTotal,
  trpcCacheLookupDuration,
  trpcDbQueryDuration,
  trpcProcedureDuration,
} from "./lib/metrics.ts";
import { dbQuerySemaphore } from "./lib/semaphore.ts";

export interface Context {
  db: Database;
  userId: string | null;
}

/** Context after auth middleware — userId is guaranteed non-null. */
interface AuthenticatedContext extends Context {
  userId: string;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;

// Auth middleware — rejects unauthenticated requests
const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } as AuthenticatedContext });
});

export const protectedProcedure = t.procedure.use(isAuthenticated);

export const CacheTTL = {
  SHORT: 2 * 60 * 1000, // 2 min
  MEDIUM: 10 * 60 * 1000, // 10 min
  LONG: 60 * 60 * 1000, // 1 hour
} as const;

function cached(ttlMs: number) {
  return t.middleware(async ({ ctx, path, type, getRawInput, next }) => {
    const start = performance.now();
    const rawInput = await getRawInput();
    // Include userId in cache key to prevent cross-user data leaks
    const key = `${ctx.userId ?? "anon"}:${path}:${JSON.stringify(rawInput)}`;

    // Cache lookup
    const cacheLookupStart = performance.now();
    const hit = await queryCache.get(key);
    trpcCacheLookupDuration.observe(
      { procedure: path, hit: hit !== undefined ? "true" : "false" },
      (performance.now() - cacheLookupStart) / 1000,
    );

    if (hit !== undefined) {
      cacheHitsTotal.inc({ procedure: path });
      trpcProcedureDuration.observe(
        { procedure: path, type, cache_hit: "true" },
        (performance.now() - start) / 1000,
      );
      return { ok: true as const, data: hit, marker: middlewareMarker };
    }

    cacheMissesTotal.inc({ procedure: path });

    // DB query (everything in next()), limited by semaphore to prevent
    // overwhelming postgres when a batch request triggers many cache misses
    const dbStart = performance.now();
    const result = await dbQuerySemaphore.run(() => next());
    trpcDbQueryDuration.observe({ procedure: path }, (performance.now() - dbStart) / 1000);

    trpcProcedureDuration.observe(
      { procedure: path, type, cache_hit: "false" },
      (performance.now() - start) / 1000,
    );
    if (result.ok) {
      await queryCache.set(key, result.data, ttlMs);
    }
    return result;
  });
}

/** Cached protected query (requires auth, cache scoped by userId). */
export const cachedProtectedQuery = (ttl: number) => protectedProcedure.use(cached(ttl));
