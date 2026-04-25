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
  trpcSlowQueriesTotal,
} from "./lib/metrics.ts";
import { logger } from "./logger.ts";

export interface Context {
  db: Database;
  userId: string | null;
  /** IANA timezone from client (e.g. "America/Los_Angeles"). Falls back to "UTC". */
  timezone: string;
  /** Client app semantic version, if provided (e.g. "1.2.3"). */
  appVersion?: string;
  /** Client asset/update identifier, if provided (e.g. Expo updateId). */
  assetsVersion?: string;
}

/** Context after auth middleware — userId is guaranteed non-null. */
export interface AuthenticatedContext extends Context {
  userId: string;
}

const trpc = initTRPC.context<Context>().create();

export const router = trpc.router;
// Auth middleware — rejects unauthenticated requests
const isAuthenticated = trpc.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const authenticatedCtx: AuthenticatedContext = { ...ctx, userId: ctx.userId };
  return next({ ctx: authenticatedCtx });
});

export const publicProcedure = trpc.procedure;
export const protectedProcedure = trpc.procedure.use(isAuthenticated);

// Admin middleware — requires authenticated user with is_admin flag
const isAdminUser = trpc.middleware(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const { isAdmin } = await import("./auth/admin.ts");
  const admin = await isAdmin(ctx.db, ctx.userId);
  if (!admin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  const authenticatedCtx: AuthenticatedContext = { ...ctx, userId: ctx.userId };
  return next({ ctx: authenticatedCtx });
});

export const adminProcedure = trpc.procedure.use(isAdminUser);

export const CacheTTL = {
  SHORT: 2 * 60 * 1000, // 2 min
  MEDIUM: 10 * 60 * 1000, // 10 min
  LONG: 60 * 60 * 1000, // 1 hour
} as const;

function cached(ttlMs: number) {
  return trpc.middleware(async ({ ctx, path, type, getRawInput, next }) => {
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

    const dbStart = performance.now();
    const result = await next();
    const dbDurationMs = performance.now() - dbStart;
    const totalDurationMs = performance.now() - start;
    trpcDbQueryDuration.observe({ procedure: path }, dbDurationMs / 1000);

    if (dbDurationMs > 500) {
      trpcSlowQueriesTotal.inc({ procedure: path, type });
      logger.warn(
        `[trpc] Slow query procedure=${path} type=${type} user_id=${ctx.userId ?? "anon"} db_duration_ms=${Math.round(dbDurationMs)} total_duration_ms=${Math.round(totalDurationMs)} cache_hit=false app_version=${ctx.appVersion ?? "unknown"} assets_version=${ctx.assetsVersion ?? "unknown"}`,
      );
    }

    trpcProcedureDuration.observe(
      { procedure: path, type, cache_hit: "false" },
      totalDurationMs / 1000,
    );
    if (result.ok) {
      await queryCache.set(key, result.data, ttlMs);
    }
    return result;
  });
}

/** Cached protected query (requires auth, cache scoped by userId). */
export const cachedProtectedQuery = (ttl: number) => protectedProcedure.use(cached(ttl));
